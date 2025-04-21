const response = require('cfn-response');

exports.handler = async function (event, context) {
  try {
    console.log(event);
    if (event.RequestType == 'Delete') {
      return await response.send(event, context, response.SUCCESS);
    }
    const initialVersion = event.ResourceProperties.initialVersion;
    if (event.RequestType == 'Create') {
      return await response.send(event, context, response.SUCCESS, { version: initialVersion }, initialVersion);
    }
    if (event.RequestType == 'Update') {
      const currentVersion = event.PhysicalResourceId; // e.g. 1.0.0
      // increment patch version
      const [major, minor, patch] = currentVersion.split('.').map(Number);
      const [oMajor, oMinor, oPatch] = initialVersion.split('.').map(Number);
      let newVersion = [major, minor, patch + 1].join('.');
      if (oMajor > major || (oMajor == major && oMinor > minor)) {
        newVersion = initialVersion;
      }
      await response.send(event, context, response.SUCCESS, { version: newVersion }, newVersion);
    }
  } catch (e) {
    console.log(e);
    await response.send(event, context, response.FAILED);
  }
};
