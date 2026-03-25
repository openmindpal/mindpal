// IMAP Poll skill - polls mailbox for new messages (stub)
exports.execute = async function execute(req) {
  return {
    uid: 0,
    internalDate: new Date().toISOString(),
    summary: {},
    body: {},
    attachments: [],
    watermarkAfter: { uidNext: Number(req?.input?.uidNext ?? 0) + 1 },
  };
};
