// Compatibility entrypoint for the existing legacy native suite.
// Explicit --approved-local-only and reviewed external tools remain required.
if(!process.argv.some(value=>value.startsWith('--suite=')))process.argv.push('--suite=legacy');
await import('./run-native.mjs');
