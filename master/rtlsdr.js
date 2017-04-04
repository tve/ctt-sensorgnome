/*
  implement a plan for an rtlsdr device

  This object represents a plugged-in rtlsdr device and associated plan.
  As soon as it is created, it begins applying the plan.  This means:
  - issuing VAH commands to start the device (on whatever schedule)
  - issuing shell commands to set device parameters (on whatever schedule)
  - respond to "devRemoved" messages by shutting down
  - respond to "devStalled" messages by and resetting + restarting the
    device

  Most of the work is done by a modified version of rtl_tcp, to which
  we establish two half-duplex connections.  rtl_tcp listens to the
  first for commands to start/stop streaming and set tuning and filtering
  parameters.  rtl_tcp sends streamed samples down the second connection.
  The first connection is from nodejs, running this module.
  The second connection is opened by vamp-alsa-host, after we ask it
  to "open" the rtlsdr device.

*/

RTLSDR = function(matron, dev, devPlan) {
    Sensor.Sensor.call(this, matron, dev, devPlan);
    // path to the socket that rtl_tcp will use
    // e.g. /tmp/rtlsdr-1:4.sock for a device with usb path 1:4 (bus:dev)
    this.sockPath = "/tmp/rtlsdr-" + dev.attr.usbPath + ".sock";
    // path to rtl_tcp
    this.prog = "/home/pi/proj/librtlsdr/build/src/rtl_tcp";

    // hardware rate needed to achieve plan rate;
    // same algorithm as used in vamp-alsa-host/RTLSDRMinder::getHWRateForRate
    // i.e. find the smallest exact multiple of the desired rate that is in
    // the allowed range of hardware rates.

    var rate = devPlan.plan.rate;
    if (rate <= 0 || rate > 3200000) {
        console.log("rtlsdr: requested rate not within hardware range; using 48000");
        rate = 48000;
    }

    this.hw_rate = rate;
    for(;;) {
        if ((this.hw_rate >= 225001 && this.hw_rate <= 300000) || (this.hw_rate >= 900001 && this.hw_rate <= 3200000))
            break;
        this.hw_rate += rate;
    }

    // callback closures
    this.this_serverDied       = this.serverDied.bind(this);
    this.this_cmdSockConnected = this.cmdSockConnected.bind(this);
    this.this_connectCmd       = this.connectCmd.bind(this);
    this.this_serverReady      = this.serverReady.bind(this);
    this.this_cmdSockProblem   = this.cmdSockProblem.bind(this);
    this.this_spawnServer      = this.spawnServer.bind(this);

};

RTLSDR.prototype = Object.create(Sensor.Sensor.prototype);
RTLSDR.prototype.constructor = RTLSDR;

RTLSDR.prototype.rtltcpCmds = {
    // table of command recognized by rtltcp
    // the command is sent as a byte, followed by a big-endian 32-bit parameter

    frequency:        1, // frequency in Hz
    rate:             2, // sampling rate, in Hz
    gain_mode:        3, // whether or not to allow gains to be set (0 = no, 1 = yes)
    tuner_gain:       4, // in units of 0.1 dB
    freq_correction:  5, // in units of ppm; we don't use this
    if_gain:          6, // (stage << 16) | (X) where X is in units of 0.1 dB, and stage is 1..6
    test_mode:        7, // send counter instead of real data, for testing (0 = no, 1 = yes)
    agc_mode:         8, // automatic gain control (0 = no, 1 = yes); not sure which gain stages are affected
    direct_sampling:  9, // sample RF directly, rather than IF stage; 0 = no, 1 = yes (not for radio frequencies above 10 MHz)
    offset_tuning:   10, // detune away from exact carrier frequency, to avoid deadzone in some tuners; 0 = no, 1 = yes
    rtl_xtal:        11, // set use of crystal built into rtl8232 chip? (vs off-chip tuner); 0 = no, 1 = yes
    tuner_xtal:      12, // set use of crystal on tuner (vs off-board tuner); 0 = no, 1 = yes
    tuner_gain:      13, // number of possible settings is returned when first connecting to rtl_tcp
    streaming:       14  // have rtl_tcp start (1) or stop (0) submitting URBs and sending sample data to other connection
};

RTLSDR.prototype.hw_devPath = function() {

    // the device path parsable by vamp-alsa-host/RTLMinder;
    // it looks like rtlsdr:/tmp/rtlsdr-1:4.sock

    return "rtlsdr:" + this.sockPath;
};

RTLSDR.prototype.hw_init = function(callback) {
    this.initCallback = callback;
    this.spawnServer();   // launch the rtl_tcp process
};

RTLSDR.prototype.spawnServer = function() {
    if (this.quitting)
        return;
    this.cmdSock = null;
    console.log("RTLSDR about to spawn server\n");
    var server = ChildProcess.spawn(this.prog, ["-p", this.sockPath, "-d", this.dev.attr.usbPath, "-s", this.hw_rate]);
    server.on("exit", this.this_serverDied);
    server.on("error", this.this_serverDied);
    server.stdout.on("data", this.this_serverReady);
    this.server = server;
};

RTLSDR.prototype.serverReady = function(data) {
    this.server.stdout.removeListener("data", this.this_serverReady);
    this.connectCmd();
};

RTLSDR.prototype.connectCmd = function() {
    // server is listening for connections, so connect
    if (this.cmdSock) {
        return;
    }
//    console.log("about to connect command socket\n")
    this.cmdSock = Net.connect(this.sockPath, this.this_cmdSockConnected);
    this.cmdSock.on("error" , this.this_cmdSockProblem);
//    this.cmdSock.on("end"   , this.this_cmdSockProblem);
//    this.cmdSock.on("close" , this.this_cmdSockProblem);
//    this.cmdSock.on("data"  , this.this_gotCmdReply);
};

RTLSDR.prototype.cmdSockProblem = function(e) {
//    console.log("Got command socket problem " + e.toString() + "\n");
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
    if (this.quitting || this.inDieHandler)
        return;
    setTimeout(this.this_hw_stalled, 5001);
};

RTLSDR.prototype.cmdSockConnected = function() {
    // process any queued command
//    while (this.commandQueue.length) {
//        console.log("RTLSDR about to submit queued: " + this.commandQueue[0] + "\n");
//        this.cmdSock.write(this.commandQueue.shift());
//    }
    if (this.initCallback) {
        var cb = this.initCallback;
        this.initCallback = null;
        cb();
    }
};

RTLSDR.prototype.serverDied = function(code, signal) {
//    console.log("rtl_tcp server died\n")
    if (this.inDieHandler)
        return;
    this.inDieHandler = true;
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
    if (this.dataSock) {
        this.dataSock.destroy();
        this.dataSock = null;
    }
    if (! this.quitting)
        setTimeout(this.this_spawnServer, 5000);
    if (this.connectCmdTimeout) {
        clearTimeout(this.connectCmdTimeout);
        this.connectCmdTimeout = null;
    }
    if (this.connectDataTimeout) {
        clearTimeout(this.connectDataTimeout);
        this.connectDataTimeout = null;
    }
    this.inDieHandler = false;
    this.matron.emit("RTLSDRdied")
};

RTLSDR.prototype.hw_delete = function() {
    this.server.kill("SIGKILL");
    this.server = null;
};

RTLSDR.prototype.hw_startStop = function(on) {
    // just send the 'streaming' command with appropriate value
    this.hw_setParam({par:"streaming", val:on});
};

RTLSDR.prototype.hw_stalled = function() {
    // relaunch rtl_tcp and re-establish connection
};


RTLSDR.prototype.hw_setParam = function(parSetting, callback) {
    // create the 5-byte command and send it to the socket
    var cmdBuf = new Buffer(5);
    var cmdNo = this.rtltcpCmds[parSetting.par];
    if (cmdNo && this.cmdSock) {
        cmdBuf.writeUInt8(cmdNo, 0);
        cmdBuf.writeUInt32(parSetting.val, 1);
        cmdSock.write(cmdBuf, callback);
    };
};

exports.RTLSDR = RTLSDR;