// Preloaded with `node --require` so statusline countdowns are deterministic.
// FREEZE_NOW (ms since epoch) pins Date.now() and argument-less `new Date()`.
const frozen = Number(process.env.FREEZE_NOW);
if (Number.isFinite(frozen)) {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [frozen]));
    }
    static now() {
      return frozen;
    }
  }
  global.Date = FrozenDate;
}
