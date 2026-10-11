/** Chat limits in one place. Group size is configurable; the rest are product rules from the spec. */
export const CHAT_LIMITS = {
  groupMaxMembers: Number(process.env.CHAT_GROUP_MAX_MEMBERS) || 100,
  groupsPerDay: 10,
  linksPerHour: 30,
  linkTtlMs: 24 * 60 * 60 * 1000,
  messageMaxChars: 4000,
  editWindowMs: 15 * 60 * 1000,
  pageSize: 30,
  previewChars: 120,
  groupNameMaxChars: 80,
};
