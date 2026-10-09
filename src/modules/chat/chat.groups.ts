import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { AuthUser } from '../../types';
import { ApiError } from '../../utils/apiError';
import { escapeRegex, str } from '../../utils/request';
import { User } from '../users/user.model';
import { CHAT_LIMITS } from './chat.constants';
import { claimAssets, isObjectKey, releaseObject, unclaimAssets } from '../media/media.service';
import { emitToUsers } from './chat.events';
import { forgetMembers } from './chat.members';
import { Conversation, ConversationMember, GroupInviteLink, GroupRequest, IConversation } from './chat.model';
import { assertVerifiedMember, isFaculty, verifiedMembersOf } from './chat.policy';
import { oid, postSystemMessage, requireMember } from './chat.service';

/**
 * Group rules: college-only, admins and members, open (searchable, request to join) or closed
 * (invites and links). Every change re-checks membership/role server-side.
 */

const PERSON = 'name avatar role';
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** The caller is an admin of this live group. */
const requireAdmin = async (user: AuthUser, groupId: unknown) => {
  const access = await requireMember(user, groupId);
  if (access.conversation.type !== 'group') throw new ApiError(404, 'NOT_FOUND', 'Group not found');
  if (access.member.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only group admins can do this.');
  return access;
};

/** A live group the caller can see from outside (search, join, links) - same college only. */
const findCollegeGroup = async (user: AuthUser, groupId: unknown) => {
  const college = assertVerifiedMember(user);
  const id = oid(groupId);
  const group = id ? await Conversation.findOne({ _id: id, type: 'group', archivedAt: { $exists: false } }).lean() : null;
  if (!group || String(group.college) !== college) throw new ApiError(404, 'NOT_FOUND', 'Group not found');
  return group;
};

/** Tell members (and anyone just removed) to refetch the group. */
const notifyGroup = async (groupId: Types.ObjectId, extra: string[] = []) => {
  await forgetMembers(groupId);
  const ids = await ConversationMember.distinct('userId', { conversationId: groupId });
  emitToUsers([...ids, ...extra], 'conversation:updated', { conversationId: groupId });
};

/** Adds a member if there is room (atomic count check), then posts "joined". */
const addMember = async (group: IConversation, userId: string, role: 'admin' | 'member' = 'member') => {
  const reserved = await Conversation.findOneAndUpdate(
    { _id: group._id, archivedAt: { $exists: false }, memberCount: { $lt: CHAT_LIMITS.groupMaxMembers } },
    { $inc: { memberCount: 1 } }
  );
  if (!reserved) throw new ApiError(409, 'CONFLICT', `This group is full (${CHAT_LIMITS.groupMaxMembers} members).`);
  try {
    await ConversationMember.create({ conversationId: group._id, userId, role, lastMessageAt: new Date() });
  } catch (error) {
    await Conversation.updateOne({ _id: group._id }, { $inc: { memberCount: -1 } });
    if ((error as { code?: number }).code === 11000) throw new ApiError(409, 'CONFLICT', 'Already a member.');
    throw error;
  }
  await postSystemMessage(group, userId, { event: 'joined' });
  await notifyGroup(group._id);
};

/** Still a verified member of the group's college (checked again at the moment of joining). */
const assertCollegeMember = async (userId: Types.ObjectId | string, college: Types.ObjectId | undefined) => {
  if (!college || !(await User.exists({ _id: userId, ...verifiedMembersOf(college) }))) {
    throw new ApiError(403, 'FORBIDDEN', 'Only verified members of this college can join.');
  }
};

/* ------------------------------------------------------------------ */
/* Create, search, settings                                            */
/* ------------------------------------------------------------------ */

export const createGroup = async (user: AuthUser, body: unknown) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const college = assertVerifiedMember(user);
  const name = str(input.name);
  if (!name || name.length > CHAT_LIMITS.groupNameMaxChars) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Group name is required (up to ${CHAT_LIMITS.groupNameMaxChars} characters).`);
  }
  const visibility = str(input.visibility);
  if (visibility !== 'open' && visibility !== 'closed') throw new ApiError(400, 'VALIDATION_ERROR', 'Choose open or closed.');

  const group = (
    await Conversation.create({
      type: 'group',
      name,
      college,
      visibility,
      allowFaculty: visibility === 'open' && input.allowFaculty === true,
      memberCount: 1,
    })
  ).toObject();
  await ConversationMember.create({ conversationId: group._id, userId: user.userId, role: 'admin', lastMessageAt: new Date() });
  await postSystemMessage(group, user.userId, { event: 'created', name });
  const invited = Array.isArray(input.inviteUserIds) ? await sendInvites(user, group, input.inviteUserIds) : 0;
  return { group, invited };
};

/** Open groups of my college by name, with my status for each. */
export const searchOpenGroups = async (user: AuthUser, rawQuery: unknown) => {
  const college = assertVerifiedMember(user);
  const q = str(rawQuery).slice(0, 50);
  const groups = await Conversation.find({
    college,
    type: 'group',
    visibility: 'open',
    archivedAt: { $exists: false },
    ...(q && { name: { $regex: escapeRegex(q), $options: 'i' } }),
  })
    .select('name memberCount allowFaculty photo')
    .sort({ name: 1 })
    .limit(20)
    .lean();
  const ids = groups.map((g) => g._id);
  const [mine, pending] = await Promise.all([
    ConversationMember.distinct('conversationId', { userId: user.userId, conversationId: { $in: ids } }),
    GroupRequest.distinct('conversationId', { userId: user.userId, status: 'pending', conversationId: { $in: ids } }),
  ]);
  const has = (list: unknown[], id: unknown) => list.some((x) => String(x) === String(id));
  return groups.map((g) => ({ ...g, isMember: has(mine, g._id), requested: has(pending, g._id) }));
};

export const updateGroup = async (user: AuthUser, groupId: unknown, body: unknown) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const { conversation } = await requireAdmin(user, groupId);
  const $set: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = str(input.name);
    if (!name || name.length > CHAT_LIMITS.groupNameMaxChars) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid group name.');
    $set.name = name;
  }
  if (typeof input.allowFaculty === 'boolean' && conversation.visibility === 'open') $set.allowFaculty = input.allowFaculty;
  // Group photo: an uploaded public asset id, or '' to remove. The old object is released after saving.
  const $unset: Record<string, 1> = {};
  let claimed: string[] = [];
  if (input.photoAssetId !== undefined) {
    const assetId = str(input.photoAssetId);
    if (assetId) {
      const [media] = await claimAssets(user, assetId, ['group_photo']);
      $set.photo = media.objectKey;
      claimed = [media.assetId];
    } else $unset.photo = 1;
  }
  if (Object.keys($set).length === 0 && Object.keys($unset).length === 0) return conversation;
  let updated;
  try {
    updated = await Conversation.findByIdAndUpdate(conversation._id, { $set, $unset }, { new: true }).lean();
  } catch (error) {
    await unclaimAssets(claimed);
    throw error;
  }
  if (input.photoAssetId !== undefined && isObjectKey(conversation.photo) && conversation.photo !== $set.photo) await releaseObject(conversation.photo);
  if ($set.name && $set.name !== conversation.name) {
    await postSystemMessage(updated!, user.userId, { event: 'renamed', name: String($set.name) });
  }
  await notifyGroup(conversation._id);
  return updated;
};

/* ------------------------------------------------------------------ */
/* Joining: requests, invites, links                                   */
/* ------------------------------------------------------------------ */

/** Join directly (faculty + allowFaculty in an open group) or file a request. */
const joinOrRequest = async (user: AuthUser, group: IConversation, viaLink: boolean) => {
  if (await ConversationMember.exists({ conversationId: group._id, userId: user.userId })) {
    return { joined: true, conversationId: group._id };
  }
  if (!viaLink && group.visibility !== 'open') throw new ApiError(404, 'NOT_FOUND', 'Group not found');
  if (group.visibility === 'open' && group.allowFaculty && isFaculty(user)) {
    await addMember(group, user.userId);
    return { joined: true, conversationId: group._id };
  }
  try {
    await GroupRequest.create({ conversationId: group._id, userId: user.userId, kind: 'request' });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error; // already pending: same answer
  }
  await notifyGroup(group._id);
  return { requested: true, conversationId: group._id };
};

export const joinGroup = async (user: AuthUser, groupId: unknown) => joinOrRequest(user, await findCollegeGroup(user, groupId), false);

export const listRequests = async (user: AuthUser, groupId: unknown) => {
  const { conversation } = await requireAdmin(user, groupId);
  const requests = await GroupRequest.find({ conversationId: conversation._id, kind: 'request', status: 'pending' })
    .sort({ createdAt: 1 })
    .populate('userId', PERSON)
    .lean();
  return requests.map(({ userId, ...r }) => ({ ...r, user: userId }));
};

export const decideRequest = async (user: AuthUser, groupId: unknown, requestId: unknown, approve: boolean) => {
  const { conversation } = await requireAdmin(user, groupId);
  const id = oid(requestId);
  const request = id ? await GroupRequest.findOne({ _id: id, conversationId: conversation._id, kind: 'request', status: 'pending' }).lean() : null;
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Request not found');
  const alreadyIn = await ConversationMember.exists({ conversationId: conversation._id, userId: request.userId });
  if (approve && !alreadyIn) {
    await assertCollegeMember(request.userId, conversation.college);
    await addMember(conversation, String(request.userId));
  }
  await GroupRequest.updateOne({ _id: request._id }, { $set: { status: approve ? 'approved' : 'rejected' } });
  await notifyGroup(conversation._id, [String(request.userId)]);
};

/** Pending invites for verified members of the group's college who are not in it yet. */
const sendInvites = async (user: AuthUser, group: IConversation, rawIds: unknown[]) => {
  const ids = [...new Set(rawIds.slice(0, 50).map((x) => str(x)))].filter((x) => Types.ObjectId.isValid(x) && x !== user.userId);
  if (ids.length === 0) return 0;
  const [eligible, members] = await Promise.all([
    User.find({ _id: { $in: ids }, ...verifiedMembersOf(group.college!) }).distinct('_id'),
    ConversationMember.distinct('userId', { conversationId: group._id }),
  ]);
  let targets = eligible.filter((u) => !members.some((m) => String(m) === String(u)));
  // Someone who already asked to join is simply admitted: the admin wants them in.
  const requested = await GroupRequest.find({ conversationId: group._id, kind: 'request', status: 'pending', userId: { $in: targets } }).lean();
  for (const r of requested) {
    await addMember(group, String(r.userId));
    await GroupRequest.updateOne({ _id: r._id }, { $set: { status: 'approved' } });
  }
  targets = targets.filter((u) => !requested.some((r) => String(r.userId) === String(u)));
  if (targets.length === 0) return requested.length;
  const result = await GroupRequest.insertMany(
    targets.map((userId) => ({ conversationId: group._id, userId, kind: 'invite', invitedBy: user.userId })),
    { ordered: false }
  ).catch((error) => (error as { insertedDocs?: unknown[] }).insertedDocs ?? []); // already invited: skipped
  return result.length + requested.length;
};

export const inviteUsers = async (user: AuthUser, groupId: unknown, body: unknown) => {
  const { conversation } = await requireAdmin(user, groupId);
  const rawIds = (body as { userIds?: unknown })?.userIds;
  if (!Array.isArray(rawIds)) throw new ApiError(400, 'VALIDATION_ERROR', 'userIds must be a list.');
  return { invited: await sendInvites(user, conversation, rawIds) };
};

export const myInvites = async (user: AuthUser) => {
  const invites = await GroupRequest.find({ userId: user.userId, kind: 'invite', status: 'pending' })
    .sort({ createdAt: -1 })
    .populate('conversationId', 'name memberCount visibility archivedAt')
    .populate('invitedBy', 'name')
    .lean();
  return invites
    .filter((i) => i.conversationId && !(i.conversationId as unknown as IConversation).archivedAt)
    .map(({ conversationId, ...i }) => ({ ...i, group: conversationId }));
};

export const respondInvite = async (user: AuthUser, requestId: unknown, accept: boolean) => {
  const id = oid(requestId);
  const invite = id ? await GroupRequest.findOne({ _id: id, userId: user.userId, kind: 'invite', status: 'pending' }).lean() : null;
  if (!invite) throw new ApiError(404, 'NOT_FOUND', 'Invite not found');
  if (accept) {
    const group = await Conversation.findOne({ _id: invite.conversationId, archivedAt: { $exists: false } }).lean();
    if (!group) throw new ApiError(404, 'NOT_FOUND', 'Group not found');
    await assertCollegeMember(user.userId, group.college);
    if (!(await ConversationMember.exists({ conversationId: group._id, userId: user.userId }))) await addMember(group, user.userId);
  }
  await GroupRequest.updateOne({ _id: invite._id }, { $set: { status: accept ? 'accepted' : 'declined' } });
  return { conversationId: invite.conversationId };
};

/** A new 24-hour link. The token is returned once; only its hash is stored. */
export const createLink = async (user: AuthUser, groupId: unknown) => {
  const { conversation } = await requireAdmin(user, groupId);
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + CHAT_LIMITS.linkTtlMs);
  await GroupInviteLink.create({ conversationId: conversation._id, tokenHash: hashToken(token), createdBy: user.userId, expiresAt });
  return { token, expiresAt };
};

export const useLink = async (user: AuthUser, rawToken: unknown) => {
  const token = str(rawToken);
  const link = token ? await GroupInviteLink.findOne({ tokenHash: hashToken(token) }).lean() : null;
  if (!link || link.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(410, 'LINK_EXPIRED', 'This invite link has expired or is not valid. Ask an admin for a new one.');
  }
  const college = assertVerifiedMember(user);
  const group = await Conversation.findOne({ _id: link.conversationId, type: 'group', archivedAt: { $exists: false } }).lean();
  if (!group) throw new ApiError(404, 'NOT_FOUND', 'This group no longer exists.');
  if (String(group.college) !== college) {
    throw new ApiError(403, 'FORBIDDEN', 'This invite link is for a group at another college. Groups are only open to their own college.');
  }
  return joinOrRequest(user, group, true);
};

/* ------------------------------------------------------------------ */
/* Members, roles, leaving                                             */
/* ------------------------------------------------------------------ */

const changeCount = (groupId: Types.ObjectId, by: number) => Conversation.updateOne({ _id: groupId }, { $inc: { memberCount: by } });

/** Longest-serving remaining member becomes admin when no admin is left. */
const ensureAdmin = async (group: IConversation, actorId: string) => {
  if (await ConversationMember.exists({ conversationId: group._id, role: 'admin' })) return;
  const next = await ConversationMember.findOneAndUpdate(
    { conversationId: group._id },
    { $set: { role: 'admin' } },
    { sort: { joinedAt: 1, _id: 1 }, new: true }
  ).lean();
  if (next) await postSystemMessage(group, actorId, { event: 'promoted', target: String(next.userId) });
};

const requireTarget = async (groupId: Types.ObjectId, rawUserId: unknown) => {
  const id = oid(rawUserId);
  const target = id ? await ConversationMember.findOne({ conversationId: groupId, userId: id }).lean() : null;
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'Member not found');
  return target;
};

/** Admins remove members - never other admins. */
export const removeMember = async (user: AuthUser, groupId: unknown, targetUserId: unknown) => {
  const { conversation } = await requireAdmin(user, groupId);
  const target = await requireTarget(conversation._id, targetUserId);
  if (target.role === 'admin') throw new ApiError(403, 'FORBIDDEN', 'Admins cannot remove other admins.');
  // Only the request that actually deleted the row counts it (two admins clicking at once).
  const { deletedCount } = await ConversationMember.deleteOne({ _id: target._id, role: 'member' });
  if (!deletedCount) return;
  await changeCount(conversation._id, -1);
  await postSystemMessage(conversation, user.userId, { event: 'removed', target: String(target.userId) });
  await notifyGroup(conversation._id, [String(target.userId)]);
};

export const promoteMember = async (user: AuthUser, groupId: unknown, targetUserId: unknown) => {
  const { conversation } = await requireAdmin(user, groupId);
  const target = await requireTarget(conversation._id, targetUserId);
  if (target.role === 'admin') return;
  await ConversationMember.updateOne({ _id: target._id }, { $set: { role: 'admin' } });
  await postSystemMessage(conversation, user.userId, { event: 'promoted', target: String(target.userId) });
  await notifyGroup(conversation._id);
};

/** An admin becomes a member; if no admin would remain, the longest-serving member takes over. */
export const stepDown = async (user: AuthUser, groupId: unknown) => {
  const { conversation, member } = await requireAdmin(user, groupId);
  if (conversation.memberCount <= 1) throw new ApiError(409, 'CONFLICT', 'You are the only member. Leave the group instead.');
  await ConversationMember.updateOne({ _id: member._id }, { $set: { role: 'member' } });
  await postSystemMessage(conversation, user.userId, { event: 'demoted', target: user.userId });
  if (!(await ConversationMember.exists({ conversationId: conversation._id, role: 'admin' }))) {
    const next = await ConversationMember.findOneAndUpdate(
      { conversationId: conversation._id, userId: { $ne: new Types.ObjectId(user.userId) } },
      { $set: { role: 'admin' } },
      { sort: { joinedAt: 1, _id: 1 }, new: true }
    ).lean();
    if (next) await postSystemMessage(conversation, user.userId, { event: 'promoted', target: String(next.userId) });
  }
  await notifyGroup(conversation._id);
};

/** Leave; admin hand-over applies; the last member leaving archives the group. */
export const leaveGroup = async (user: AuthUser, groupId: unknown) => {
  const { conversation, member } = await requireMember(user, groupId);
  if (conversation.type !== 'group') throw new ApiError(400, 'VALIDATION_ERROR', 'Only groups can be left.');
  const { deletedCount } = await ConversationMember.deleteOne({ _id: member._id });
  if (!deletedCount) return { archived: false }; // a second tab already left
  const remaining = await ConversationMember.countDocuments({ conversationId: conversation._id });
  if (remaining === 0) {
    await Conversation.updateOne({ _id: conversation._id }, { $set: { archivedAt: new Date(), memberCount: 0 } });
    await Promise.all([
      GroupRequest.updateMany({ conversationId: conversation._id, status: 'pending' }, { $set: { status: 'rejected' } }),
      GroupInviteLink.deleteMany({ conversationId: conversation._id }),
    ]);
    await forgetMembers(conversation._id);
    emitToUsers([user.userId], 'conversation:updated', { conversationId: conversation._id });
    return { archived: true };
  }
  await changeCount(conversation._id, -1);
  await postSystemMessage(conversation, user.userId, { event: 'left' });
  if (member.role === 'admin') await ensureAdmin(conversation, user.userId);
  await notifyGroup(conversation._id, [user.userId]);
  return { archived: false };
};
