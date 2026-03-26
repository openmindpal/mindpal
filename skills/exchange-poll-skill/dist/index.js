// Exchange Poll skill - polls Exchange mailbox
exports.execute = async function execute(req) {
  // Mock response for testing: returns Graph API delta format
  return {
    messages: [],
    scannedCount: 0,
    nextLink: null,
    deltaLink: req?.input?.cursorUrl || null,
  };
};
