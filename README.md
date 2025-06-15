# PHP Live Server VSCode Extension

Serve your PHP projects with a live server directly from VSCode.

## Features

*   Start and stop a PHP server.
*   View your PHP project live in the browser.
*   Hot reload the browser when you change `php`, `html`, `css`, or `js` files.
*   (More features to come)

## Usage

There are several ways to start or stop the server:

1.  **From the Status Bar:**
    *   Click the `$(play) Start PHP Server` button in the status bar at the bottom-right of your VSCode window.
    *   When the server is running, the button will change to `$(debug-stop) Stop PHP Server`. Click it again to stop the server.

2.  **From the Command Palette:**
    *   Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux).
    *   Type `Start/Stop PHP Live Server` and press `Enter`.

3.  **From the Context Menu:**
    *   Right-click on a `.php` file in the Explorer view.
    *   Or, right-click inside a `.php` editor.
    *   Select `Start/Stop PHP Live Server` from the context menu.

## Requirements

*   PHP installed on your system and added to your PATH.

## Extension Settings

This extension contributes the following settings:

*   `php-live-server.port`: Port number for the PHP server (default: `3000`).
*   `php-live-server.host`: Hostname for the PHP server (default: `localhost`).
*   `php-live-server.root`: Root directory for the PHP server (default: workspace root).
*   `php-live-server.phpPath`: Custom path to the PHP executable (e.g., `/usr/bin/php` or `C:\\php\\php.exe`). Defaults to `php`, which requires PHP to be in your system's PATH.

## Known Issues

No known issues at the moment. Please report any issues on the GitHub repository.

## Release Notes

### 0.0.1

Initial release of the PHP Live Server extension.
---

**Enjoy!**
