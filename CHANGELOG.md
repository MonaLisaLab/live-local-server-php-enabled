# Change Log

All notable changes to the "PHP-enabled Live Local Server" extension will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-06-18

### Added
- **Live Reload:** Automatically reloads the browser when `php`, `html`, `css`, or `js` files are changed.
- **PHP Auto-Detection:** Automatically searches for a PHP executable in common installation directories if it's not in the system's PATH.
- **Configuration UI:** Added settings in the VS Code UI for port, host, root, and a custom PHP path.
- **Status Bar Icon:** A convenient icon in the status bar to start and stop the server.
- **Context Menu Integration:** Added a "Start/Stop Server" command to the context menu for `.php` files.
- **Custom Icon:** The extension now has a brand new logo!
- **Sample Files:** Included a `sample` directory with `php` and `html` files for easy testing.
- **Detailed Output Channel:** A dedicated output channel for server and extension logs.
- **GIF Demo:** Added a GIF to the `README.md` to show how the extension works.

### Changed
- **Project Renamed:** Renamed the extension to "PHP-enabled Live Local Server".
- Improved error messages and user feedback notifications.

## [0.0.1] - 2025-06-18

### Added

- Initial basic structure for the VSCode extension.
- `package.json`: Defines metadata, dependencies, and scripts.
- `tsconfig.json`: Configures TypeScript compilation.
- `webpack.config.js`: Configures webpack for bundling.
- `src/extension.ts`: Implements `activate` and `deactivate` functions.
- `.vscodeignore`: Specifies files to ignore when packaging.
- `README.md`: Basic documentation.
- `CHANGELOG.md`: Tracks changes.
