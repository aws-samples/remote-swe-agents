const response = require('cfn-response');
const crypto = require('crypto');

exports.handler = async function (event, context) {
  try {
    console.log(event);
    if (event.RequestType == 'Delete') {
      return await response.send(event, context, response.SUCCESS);
    }

    const prefix = event.ResourceProperties.prefix ?? '';
    const length = event.ResourceProperties.length ?? '8';
    const generate = () => {
      const random = crypto.randomBytes(parseInt(length)).toString('hex');
      return `${prefix}${random.slice(0, length)}`;
    };

    if (event.RequestType == 'Create') {
      const generated = generate();
      return await response.send(event, context, response.SUCCESS, { generated }, generated);
    }
    if (event.RequestType == 'Update') {
      const current = event.PhysicalResourceId;
      if (current.startsWith(prefix)) {
        return await response.send(event, context, response.SUCCESS, { generated: current }, current);
      }
      const generated = generate();
      return await response.send(event, context, response.SUCCESS, { generated }, generated);
    }
  } catch (e) {
    console.log(e);
    await response.send(event, context, response.FAILED);
  }
};
