// lesson-capture.js — monotonic operation ids so late async capture work cannot commit after timeout or superseding navigation.
(function initLexoraLessonCapture(global) {
  let _deepCaptureEpoch = 0;
  let _autoCaptureEpoch = 0;

  function beginDeepCaptureOp() {
    return ++_deepCaptureEpoch;
  }

  /**
   * When a deep capture times out, bump the epoch only if this op is still the latest
   * (so we do not invalidate a newer capture that started while the old one was running).
   */
  function invalidateDeepCaptureIfCurrent(opId) {
    if (opId === _deepCaptureEpoch) _deepCaptureEpoch++;
  }

  function isDeepCaptureOpCurrent(opId) {
    return opId === _deepCaptureEpoch;
  }

  /** Each top-frame navigation gets a new id; stale delayed callbacks must not save. */
  function bumpAutoCaptureAndGetId() {
    return ++_autoCaptureEpoch;
  }

  function isAutoCaptureOpCurrent(opId) {
    return opId === _autoCaptureEpoch;
  }

  global.LexoraLessonCapture = Object.freeze({
    beginDeepCaptureOp,
    invalidateDeepCaptureIfCurrent,
    isDeepCaptureOpCurrent,
    bumpAutoCaptureAndGetId,
    isAutoCaptureOpCurrent,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
