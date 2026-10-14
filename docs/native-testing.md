# Optional disposable native PostgreSQL verification

The normal install/build starts no database and applies no migration. `pnpm test` uses disposable synthetic PGlite. Native suites are optional, require explicit local setup and must never target an existing/shared/hosted database. A skipped native test is not acceptance.

The source launcher supports the reviewed Windows x64 PostgreSQL 17.11-5 portable archive only. Obtain binaries separately from the [PostgreSQL Windows downloads](https://www.postgresql.org/download/windows/) / [EDB binary archives](https://www.enterprisedb.com/download-postgresql-binaries). Nothing is downloaded or installed by the launcher, and no binaries are bundled in this repository.

Place the reviewed ZIP and extracted runtime in an ignored `.test-tools/` directory, or explicitly supply `--runtime-root` pointing to a directory with this layout:

```text
postgresql-17.11-5-windows-x64-binaries.zip
postgresql-17.11-5/
  pgsql/bin/
  pgsql/lib/
  pgsql/share/
```

The reviewed archive SHA-256 is `80379B2C04D51C30225532E0AE04509899141E9957ED096FE749D7FD9DF8F82F`. Tool checksums are source-controlled in `tests/support/portable-postgresql.json`; the helper verifies the supplied archive and four executables before execution. Publisher signatures were not established; these are reviewed local hash pins, not a claim of vendor signature verification. Extract safely into the selected tools directory and retain required runtime libraries/share files.

Run each suite separately after authorizing disposable local execution:

```text
pnpm run test:native:portable --suite=legacy --approved-local-only
pnpm run test:native:portable --suite=owner --approved-local-only
```

For a reviewed external tool cache, append `--runtime-root="path/to/reviewed-tools"`. The launcher reads tools there but writes cluster/password/log/witness files only under this clone's ignored `.test-data/`. It creates a fresh random loopback port and database, uses transient synthetic credentials, verifies PID/data-directory ownership before restart/stop, and stops its own cluster in cleanup. It does not register a Windows service, modify machine settings or discover existing databases.

The owner suite also starts `tests/support/owner-app-child.mjs` with constructor-injected synthetic auth and verifies application/database restart persistence. This child is test source, not an application entrypoint or an environment-selectable fake mode. Private IPC/witness credentials are never committed; the witness is consumed/unlinked.

`pnpm run test:native` can instead use separately prepared, explicitly confirmed fresh local instances through the test variables named in the test files. Those guards reject shared/nonempty environments and require disposable confirmation. Prefer the launcher for the reproducible reviewed Windows path. Linux/macOS binaries and other PostgreSQL versions require separately reviewed test setup; there is no automatic installer or version substitution.
