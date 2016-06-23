var fs = require('fs');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var awsIot = require('aws-iot-device-sdk');

var _config, _device, _command, _cargs, _cproc, _lastStartup;

function start() {
  var configFile = process.env.AGENT_CONFIG || './config.json';
  var configJSON = fs.readFileSync(configFile);
  _config = JSON.parse(configJSON);

  var args = process.argv;
  for (var i=0; i<args.length-1; i++) {
    if (args[i] === 'run') {
      _command = args[i+1];
      _cargs = args.slice(i+2);
    }
  }
  if (!_command) {
    console.error('Usage: enebular-agent-aws-iot run <command> [command_args...]');
    process.exit(1);
  }

  _device = setupDevice();
}

function startupChildProcess(onStartup, onShutdown) {
  _lastStartup = Date.now();
  _cproc = spawn(_command, _cargs, { stdio: 'inherit' });
  _cproc.on('error', console.error.bind(console));
  _cproc.once('exit', function() {
    _cproc = null;
    if (onShutdown) { onShutdown(); }
  });
  if (onStartup) { onStartup(); }
}

function isChildProcessRunning() {
  return !!_cproc;
}

function restartChildProcess(onStartup, onShutdown) {
  shutdownChildProcess(function() {
    startupChildProcess(onStartup, onShutdown);
  });
}

function shutdownChildProcess(cb) {
  if (_cproc) {
    _cproc.kill();
    _cproc.once('exit', function() {
      setTimeout(function() { cb(); }, 10);
    });
  } else {
    cb();
  }
}


function setupDevice() {
  var device = awsIot.thingShadow(_config);
  device.on('connect', function() {
    console.log('>> connected to AWS IoT');
    device.register(_config.thingName, { ignoreDeltas: false, persistentSubscribe: true });
    setTimeout(function() { device.get(_config.thingName); }, 2000);
  });

  device.on('close', function() {
    console.log('>> AWS IoT connection closed');
    device.unregister(_config.thingName);
  });

  device.on('reconnect', function() {
    console.log('>> reconnect to AWS IoT');
    device.register(_config.thingName);
  });

  device.on('error', function(error) {
    console.log('## error', error);
  });

  device.on('offline', function() {
    console.log('>> offline : no AWS IoT connection established');
    if (typeof _cproc === 'undefined') {
      startupChildProcess(handleStartup, handleShutdown);
    }
  });

  device.once('status', function(thingName, stat, clientToken, stateObject) {
    var state = stateObject.state;
    var metadata = stateObject.metadata;
    if (state.desired.power) {
      handlePowerStateChange(state.desired.power, metadata.desired.power.timestamp);
    }
    if (state.desired.flows) {
      handleFlowsStateChange(state.desired.flows, metadata.desired.flows.timestamp);
    }
    if (state.desired.creds) {
      handleCredsStateChange(state.desired.creds, metadata.desired.creds.timestamp);
    }
    if (state.desired.packages) {
      handlePackagesStateChange(state.desired.packages, metadata.desired.packages.timestamp);
    }
  });

  device.on('delta', function(thingName, stateObject) {
    var state = stateObject.state;
    var metadata = stateObject.metadata;
    if (state.power) {
      handlePowerStateChange(state.power, metadata.power.timestamp);
    }
    if (state.flows) {
      handleFlowsStateChange(state.flows, metadata.flows.timestamp);
    }
    if (state.creds) {
      handleCredsStateChange(state.creds, metadata.creds.timestamp);
    }
    if (state.packages) {
      handlePackagesStateChange(state.packages, metadata.packages.timestamp);
    }
  });

  return device;
}

function handlePowerStateChange(power, timestamp) {
  if (power === 'on') {
    if (isChildProcessRunning()) {
      if (timestamp > _lastStartup) {
        restartChildProcess(handleStartup, handleShutdown);
      }
    } else {
      startupChildProcess(handleStartup, handleShutdown);
    }
  } else if (power === 'off') {
    shutdownChildProcess(handleShutdown);
  }
}

function handleFlowsStateChange(flows, timestamp) {
  console.log('* received flows definition => ', flows);
  fs.writeFileSync('./.node-red/flows.json', flows, 'utf-8');
  updateThingState({ flows: flows });
}

function handleCredsStateChange(creds, timestamp) {
  console.log('* received creds definition => ', creds);
  fs.writeFileSync('./.node-red/flows_cred.json', creds, 'utf-8');
  updateThingState({ creds: creds });
}

function handlePackagesStateChange(packages, timestamp) {
  console.log('* received packages definition => ', packages);
  var deps = JSON.parse(packages);
  var pkgJSON = fs.readFileSync('./package.json');
  var pkg = JSON.parse(pkgJSON);
  pkg.dependencies = Object.assign({}, pkg.dependencies, deps);
  fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2));
  exec('npm install', function(err, ret) {
    updateThingState({ packages: packages });
  });
}

function handleStartup() {
  console.log('* update the device\'s power state to ON...');
  updateThingState({ power: 'on' });
}

function handleShutdown() {
  console.log('* update the device\'s power state to OFF...');
  updateThingState({ power: 'off' });
}

function updateThingState(state) {
  _device.update(_config.thingName, { state: { reported: state } });
}

/**
 *
 */
module.exports = {
  start: start
};
