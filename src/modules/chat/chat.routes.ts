import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { CHAT_LIMITS } from './chat.constants';
import * as c from './chat.controller';

const router = Router();
router.use(authenticate);

const byUser = (req: { user?: { userId: string } }) => req.user!.userId;
// Sends fail open: a Redis blip must not stop chat (sends still need a valid, signed-in user).
const sendLimit = rateLimit({ name: 'chat-send', limit: 30, windowSeconds: 10, keyBy: byUser });
const groupLimit = rateLimit({ name: 'chat-group', limit: CHAT_LIMITS.groupsPerDay, windowSeconds: 24 * 60 * 60, keyBy: byUser });
const linkLimit = rateLimit({ name: 'chat-link', limit: CHAT_LIMITS.linksPerHour, windowSeconds: 60 * 60, keyBy: byUser });
const membershipLimit = rateLimit({ name: 'chat-membership', limit: 60, windowSeconds: 10 * 60, keyBy: byUser });

// Conversations and messages (DMs and groups)
router.get('/conversations', c.listConversations);
router.get('/unread', c.unread);
router.post('/direct', membershipLimit, c.startDirect);
router.get('/eligible', c.eligible);
router.get('/conversations/:id', c.getConversation);
router.get('/conversations/:id/messages', c.listMessages);
router.post('/conversations/:id/messages', sendLimit, c.sendMessage);
router.post('/conversations/:id/read', c.markRead);
router.patch('/messages/:messageId', sendLimit, c.editMessage);
router.delete('/messages/:messageId', c.deleteMessage);
router.post('/messages/:messageId/forward', c.forward);

// Pins, stars, shared items, clear / delete chat (fail open, like sends)
const actionLimit = rateLimit({ name: 'chat-action', limit: 60, windowSeconds: 60, keyBy: byUser });
router.post('/messages/:messageId/pin', actionLimit, c.pin);
router.delete('/messages/:messageId/pin', actionLimit, c.unpin);
router.post('/messages/:messageId/star', actionLimit, c.star);
router.delete('/messages/:messageId/star', actionLimit, c.unstar);
router.get('/conversations/:id/starred', c.starred);
router.get('/conversations/:id/shared', c.shared);
router.post('/conversations/:id/clear', actionLimit, c.clear);
router.post('/conversations/:id/hide', actionLimit, c.hide);

// Files (private bucket): upload links, discard, signed download links
const uploadLimit = rateLimit({ name: 'chat-upload', limit: 20, windowSeconds: 60, keyBy: byUser, failOpen: false });
router.post('/uploads', uploadLimit, c.startUpload);
router.delete('/uploads/:mediaId', c.discardUpload);
router.post('/media/links', rateLimit({ name: 'chat-links', limit: 120, windowSeconds: 60, keyBy: byUser }), c.mediaLinks);

// Groups
router.post('/groups', groupLimit, c.createGroup);
router.get('/groups/search', c.searchGroups);
router.patch('/groups/:id', c.updateGroup);
router.post('/groups/:id/join', membershipLimit, c.joinGroup);
router.post('/groups/:id/invites', membershipLimit, c.invite);
router.get('/groups/:id/requests', c.listRequests);
router.post('/groups/:id/requests/:requestId/approve', c.decideRequest(true));
router.post('/groups/:id/requests/:requestId/reject', c.decideRequest(false));
router.post('/groups/:id/links', linkLimit, c.createLink);
router.delete('/groups/:id/members/:userId', c.removeMember);
router.post('/groups/:id/members/:userId/promote', c.promote);
router.post('/groups/:id/step-down', c.stepDown);
router.post('/groups/:id/leave', c.leave);
router.get('/invites', c.myInvites);
router.post('/invites/:requestId/accept', c.respondInvite(true));
router.post('/invites/:requestId/decline', c.respondInvite(false));
router.post('/links/:token', membershipLimit, c.useLink);

export default router;
