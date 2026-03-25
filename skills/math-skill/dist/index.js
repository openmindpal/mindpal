// Math skill - adds two numbers
exports.execute = async function execute(req) {
  const a = Number(req?.input?.a ?? 0);
  const b = Number(req?.input?.b ?? 0);
  return { sum: a + b };
};
