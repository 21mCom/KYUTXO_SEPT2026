# KYUTXO - USB Installation Guide

## Downloading the Portable Version

### From GitHub Actions (Development Builds)

1. Go to your private GitHub repository
2. Click on **Actions** tab
3. Find the latest successful build (green checkmark)
4. Scroll down to **Artifacts** section
5. Download **KYUTXO-Windows-Portable**
6. Extract the downloaded ZIP file (GitHub automatically zips artifacts)

### From GitHub Releases (Tagged Releases)

1. Go to your private GitHub repository
2. Click on **Releases** (right sidebar)
3. Download the `.exe` file from the latest release

## Installing on USB Drive

1. **Copy the .exe file** to your USB drive (any folder works)

2. **Create a portable marker file:**
   - In the same folder as the .exe, create a new empty text file
   - Name it exactly: `portable` (no file extension)
   - This tells KYUTXO to store all data on the USB drive

3. **Your USB folder should look like:**
   ```
   E:\KYUTXO\
   ├── KYUTXO-1.0.0-Portable.exe
   └── portable
   ```

## First Run

1. Double-click the .exe file to launch KYUTXO
2. Create your master password (this gates access to the app — it does **not** encrypt the data files on the drive; see Security below)
3. A `KYUTXO_Data` folder will be automatically created on the USB drive

## Upgrading from an Older Version

1. **Back up first**: copy your whole KYUTXO folder (or export a backup from
   Settings) before upgrading.
2. Download the new `KYUTXO-<version>-Portable.exe` and place it in the same
   folder as your `portable` marker file and `KYUTXO_Data` folder.
3. Run the new exe. **The first launch over an existing vault performs a
   one-time migration** — on large vaults this takes several minutes:
   - "Upgrading Your Vault" appears before the unlock screen (schema update,
     with a moving step/row counter).
   - After you unlock, "Restoring Your Data" and then "Verifying Migrated
     Data" run with live progress.
   - **Do not force-quit while this is running.** If it is interrupted
     anyway, your data is safe — the migration resumes at the next unlock.
4. When the migration summary reports success, delete the old exe.

## Important Notes

- **Encrypt the USB drive itself** - vault data is stored on the drive without per-field encryption, so full-drive encryption (BitLocker/VeraCrypt) is your at-rest protection (see Security below)
- **Keep your password safe!** There is no recovery option - it is required to unlock the app
- **All data stays on the USB** - nothing is stored on the host computer
- **Backup your USB drive** regularly to prevent data loss
- **Works offline** - no internet connection required after first setup

## Folder Structure After Use

```
E:\KYUTXO\
├── KYUTXO-1.0.0-Portable.exe
├── portable
└── KYUTXO_Data\
    ├── IndexedDB\           ← Your database (not encrypted on disk)
    ├── Local Storage\       ← App settings
    ├── attachments\         ← Your file attachments (not encrypted on disk)
    └── (other Chromium data)
```

**Everything is self-contained** - just copy the entire folder to back up or move to another machine.

## Security

### What your master password protects (and what it doesn't)

Since the storage-format upgrade, vault rows and attachment files are stored
on the drive **without per-field encryption**. Your master password:

- **Does** gate access to the app (unlock screen)
- **Does not** encrypt the database or attachment files in `KYUTXO_Data`
- **Does not** protect exported backups — backup exports are unencrypted
  unless you explicitly enable export encryption and choose a separate
  export password when exporting from Settings

Anyone with physical access to the USB drive could read your vault data
directly from disk unless the drive itself is encrypted.

### Encrypt the drive (primary at-rest protection)

**Encrypt your entire USB drive with BitLocker (Windows) or VeraCrypt.**
This is the recommended — and only — at-rest protection for the data files
on a portable install.

### Additional tips

- Use a strong, unique master password
- Keep a backup of your USB contents in a secure location
- When exporting a backup from Settings, enable export encryption (and pick
  a strong export password) — exports are unencrypted by default
