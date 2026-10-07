// The statusline scripts colour their output; the shared usage contract is asserted on plain text.
const ANSI = /\x1b\[[0-9;]*m/g;

module.exports = { stripAnsi: (text) => String(text).replace(ANSI, '') };
