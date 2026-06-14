# Project Memory Index

- [Build-time false alarms](build-false-alarms.md) — KYUTXO has a known `tsc --noEmit` error baseline that does NOT block Vite, and editing AuthContext live throws phantom useAuth/HMR errors.
- [Startup migration design](startup-migration-design.md) — legacy decrypt + path migration are fire-and-forget from login; must stay single-flighted, serialized, and gated to avoid IndexedDB contention on large vaults.
