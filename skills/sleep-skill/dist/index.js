// Sleep skill - waits for specified milliseconds
exports.execute = async function execute(req) {
  const ms = Math.min(Number(req?.input?.ms ?? 0), 10000);
  await new Promise(resolve => setTimeout(resolve, ms));
  return { sleptMs: ms };
};
