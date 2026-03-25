// Exchange Poll skill - polls Exchange mailbox (stub)
exports.execute = async function execute(req) {
  return {
    items: [],
    watermarkAfter: { syncState: req?.input?.syncState ?? "" },
  };
};
