import { asyncHandler } from '../../utils/apiError';
import { discardChatUpload } from './chat.attachments';
import * as groups from './chat.groups';
import * as chat from './chat.service';

/** Thin REST layer: every rule is in chat.service / chat.groups (shared with the socket handlers). */

export const listConversations = asyncHandler(async (req, res) => {
  res.json(await chat.listConversations(req.user!, req.query));
});
export const unread = asyncHandler(async (req, res) => {
  res.json(await chat.unreadTotals(req.user!));
});
export const startDirect = asyncHandler(async (req, res) => {
  res.json({ conversation: await chat.startDirect(req.user!, req.body?.userId) });
});
export const eligible = asyncHandler(async (req, res) => {
  res.json({ people: await chat.searchEligible(req.user!, req.query.q) });
});
export const getConversation = asyncHandler(async (req, res) => {
  res.json(await chat.getConversation(req.user!, req.params.id));
});
export const listMessages = asyncHandler(async (req, res) => {
  res.json(await chat.listMessages(req.user!, req.params.id, req.query.before));
});
export const sendMessage = asyncHandler(async (req, res) => {
  res.status(201).json({ message: await chat.sendMessage(req.user!, req.params.id, req.body) });
});
export const markRead = asyncHandler(async (req, res) => {
  res.json(await chat.markRead(req.user!, req.params.id, req.body?.messageId));
});
export const editMessage = asyncHandler(async (req, res) => {
  res.json({ message: await chat.editMessage(req.user!, req.params.messageId, req.body?.text) });
});
export const deleteMessage = asyncHandler(async (req, res) => {
  res.json({ message: await chat.deleteMessage(req.user!, req.params.messageId) });
});

export const startUpload = asyncHandler(async (req, res) => {
  res.status(201).json(await chat.startUpload(req.user!, req.body));
});
export const discardUpload = asyncHandler(async (req, res) => {
  await discardChatUpload(req.user!, req.params.mediaId);
  res.json({ ok: true });
});
export const mediaLinks = asyncHandler(async (req, res) => {
  res.json({ links: await chat.mediaLinks(req.user!, req.body?.mediaIds) });
});
export const forward = asyncHandler(async (req, res) => {
  res.status(201).json({ messages: await chat.forwardMessage(req.user!, req.params.messageId, req.body?.conversationIds) });
});

export const createGroup = asyncHandler(async (req, res) => {
  res.status(201).json(await groups.createGroup(req.user!, req.body));
});
export const searchGroups = asyncHandler(async (req, res) => {
  res.json({ groups: await groups.searchOpenGroups(req.user!, req.query.q) });
});
export const updateGroup = asyncHandler(async (req, res) => {
  res.json({ group: await groups.updateGroup(req.user!, req.params.id, req.body) });
});
export const joinGroup = asyncHandler(async (req, res) => {
  res.json(await groups.joinGroup(req.user!, req.params.id));
});
export const invite = asyncHandler(async (req, res) => {
  res.json(await groups.inviteUsers(req.user!, req.params.id, req.body));
});
export const listRequests = asyncHandler(async (req, res) => {
  res.json({ requests: await groups.listRequests(req.user!, req.params.id) });
});
export const decideRequest = (approve: boolean) =>
  asyncHandler(async (req, res) => {
    await groups.decideRequest(req.user!, req.params.id, req.params.requestId, approve);
    res.json({ ok: true });
  });
export const myInvites = asyncHandler(async (req, res) => {
  res.json({ invites: await groups.myInvites(req.user!) });
});
export const respondInvite = (accept: boolean) =>
  asyncHandler(async (req, res) => {
    res.json(await groups.respondInvite(req.user!, req.params.requestId, accept));
  });
export const createLink = asyncHandler(async (req, res) => {
  res.status(201).json(await groups.createLink(req.user!, req.params.id));
});
export const useLink = asyncHandler(async (req, res) => {
  res.json(await groups.useLink(req.user!, req.params.token));
});
export const removeMember = asyncHandler(async (req, res) => {
  await groups.removeMember(req.user!, req.params.id, req.params.userId);
  res.json({ ok: true });
});
export const promote = asyncHandler(async (req, res) => {
  await groups.promoteMember(req.user!, req.params.id, req.params.userId);
  res.json({ ok: true });
});
export const stepDown = asyncHandler(async (req, res) => {
  await groups.stepDown(req.user!, req.params.id);
  res.json({ ok: true });
});
export const leave = asyncHandler(async (req, res) => {
  res.json(await groups.leaveGroup(req.user!, req.params.id));
});
