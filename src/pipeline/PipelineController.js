let _running       = false;
let _stopRequested = false;

module.exports = {
    start()     { _running = true;  _stopRequested = false; },
    stop()      { _stopRequested = true; },
    reset()     { _running = false; _stopRequested = false; },
    isRunning() { return _running; },
    shouldStop(){ return _stopRequested; },
};
