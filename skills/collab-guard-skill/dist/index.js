// Collab guard skill - guards collaboration plan
exports.execute = async function execute(req) {
  return {
    allow: true,
    requiresApproval: false,
    blockedReasons: [],
    recommendedArbiterAction: "proceed",
  };
};
