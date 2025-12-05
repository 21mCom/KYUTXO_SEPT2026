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
2. Create your master password (this encrypts all your data)
3. A `KYUTXO_Data` folder will be automatically created on the USB drive

## Important Notes

- **Keep your password safe!** There is no recovery option - your data is encrypted with your password
- **All data stays on the USB** - nothing is stored on the host computer
- **Backup your USB drive** regularly to prevent data loss
- **Works offline** - no internet connection required after first setup

## Folder Structure After Use

```
E:\KYUTXO\
├── KYUTXO-1.0.0-Portable.exe
├── portable
└── KYUTXO_Data\
    ├── IndexedDB\           ← Your encrypted database
    ├── Local Storage\       ← App settings
    ├── attachments\         ← Your encrypted file attachments
    └── (other Chromium data)
```

**Everything is self-contained** - just copy the entire folder to back up or move to another machine.

## Security Tips

- Use a strong, unique master password
- Consider encrypting your entire USB drive with BitLocker or VeraCrypt
- Keep a backup of your USB contents in a secure location
