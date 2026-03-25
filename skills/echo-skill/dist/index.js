// Echo skill - returns input text as output
exports.execute = async function execute(req) {
  return { echo: String(req?.input?.text ?? "") };
};
