// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

// Run the framework-independent protocol suite when GJS is unavailable.
// Jasmine's bundled GJS build expects top-level `this` to be the global object.
// Evaluate it as a script, removing only the ES module export declaration.
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {URL} from 'node:url';
import console from 'node:console';
import process from 'node:process';

const source = await readFile(new URL('./jasmine.js', import.meta.url), 'utf8');
vm.runInThisContext(source.replace('export const getJasmineRequireObj',
    'var getJasmineRequireObj'), {filename: 'jasmine.js'});
const requireJasmine = globalThis.getJasmineRequireObj();
const jasmine = requireJasmine.core(requireJasmine);
const environment = jasmine.getEnv();
Object.assign(globalThis, requireJasmine.interface(jasmine, environment));
environment.addReporter({
    specDone(result) {
        console.log(`${result.status}: ${result.fullName}`);
        for (const failure of result.failedExpectations)
            console.error(failure.message);
    },
    jasmineDone(result) {
        process.exitCode = result.overallStatus === 'passed' ? 0 : 1;
    },
});
await import('./suites/backends/testBluetoothMultiplexer.js');
await import('./suites/backends/testBluetoothIdentity.js');
await import('./suites/backends/testBluetoothPacketReader.js');
environment.execute();
