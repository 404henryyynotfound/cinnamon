#!/usr/bin/env node
'use strict';
// Entry point for cinnamon-cli. All logic lives in lib/ so tests can inject
// process sampling and never touch real processes.

const { run } = require('../lib/cli.js');

run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`cinnamon-cli: ${error && error.message ? error.message : error}\n`);
  process.exitCode = 1;
});
