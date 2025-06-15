import * as vscode from 'vscode';
import phpServer from 'php-server';
import * as path from 'path';
import * as chokidar from 'chokidar';
import * as ws from 'ws';
import { exec } from 'child_process';
import * as fs from 'fs';

// Module-level variables
let outputChannel: vscode.OutputChannel;
let serverInstance: { stop: () => void; url: string; [key: string]: any } | null = null;
let statusBarItem: vscode.StatusBarItem;
let fileWatcher: chokidar.FSWatcher | null = null;
let webSocketServer: ws.Server | null = null;
let webSocketPort: number = 0;
const connectedSockets: Set<ws.WebSocket> = new Set();
let currentWorkspacePath: string | null = null;
let effectivePhpPath: string | null = null; // This will hold the path to the PHP executable we will use.

// Logging function
function log(message: string, type: 'info' | 'warn' | 'error' = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const fullMessage = `[${timestamp}] ${message}`;

    // Log to debug console (for extension developers)
    switch (type) {
        case 'warn':
            console.warn(fullMessage);
            break;
        case 'error':
            console.error(fullMessage);
            break;
        default:
            console.log(fullMessage);
            break;
    }

    // Log to output channel (for users)
    if (outputChannel) {
        outputChannel.appendLine(fullMessage);
        // Show output channel on warnings or errors to make them more visible
        if (type === 'warn' || type === 'error') {
            outputChannel.show(true); // true to preserve focus on the current editor
        }
    }
}

// --- PHP Path Discovery Functions ---

async function testPhpPath(phpPath: string): Promise<{ success: boolean; version: string }> {
    return new Promise((resolve) => {
        // Use quotes around the path to handle spaces
        exec(`"${phpPath}" -v`, (error, stdout, stderr) => {
            if (error) {
                log(`Path validation failed for "${phpPath}": ${stderr || error.message}`, 'info');
                resolve({ success: false, version: '' });
            } else {
                const version = stdout.split('\n')[0];
                log(`Path validation successful for "${phpPath}". Version: ${version}`, 'info');
                resolve({ success: true, version });
            }
        });
    });
}

async function findPhpExecutable(): Promise<string | null> {
    const config = vscode.workspace.getConfiguration('php-live-server');
    const configuredPath = config.get<string>('phpPath') || 'php';

    // 1. Try the configured path first
    const testResult = await testPhpPath(configuredPath);
    if (testResult.success) {
        log(`Using configured PHP path: ${configuredPath}`, 'info');
        return configuredPath;
    }
    
    // If 'php' failed, it's not in PATH. Let's search.
    log(`'${configuredPath}' is not a valid command. Searching for PHP executable in common locations...`, 'info');

    // 2. Search common paths
    const platform = process.platform;
    let searchPaths: string[] = [];
    if (platform === 'win32') {
        const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        searchPaths = [
            'C:\\php\\php.exe',
            'C:\\xampp\\php\\php.exe',
            'C:\\wamp\\bin\\php\\php.exe',
            'C:\\wamp64\\bin\\php\\php.exe',
            `${progFiles}\\php\\php.exe`,
            `${progFilesX86}\\php\\php.exe`,
        ];
    } else { // darwin, linux
        searchPaths = [
            '/usr/local/bin/php', // Common for Homebrew on Intel
            '/opt/homebrew/bin/php', // Common for Homebrew on Apple Silicon
            '/usr/bin/php', // Default on many Linux distros
            '/bin/php',
            // MAMP on macOS (common versions, adjust as needed)
            '/Applications/MAMP/bin/php/php8.2.0/bin/php',
            '/Applications/MAMP/bin/php/php8.1.13/bin/php',
            '/Applications/MAMP/bin/php/php7.4.33/bin/php',
        ];
    }

    for (const p of searchPaths) {
        try {
            await fs.promises.access(p, fs.constants.F_OK); // Check for existence
            const test = await testPhpPath(p);
            if (test.success) {
                log(`Found PHP executable at: ${p}`, 'info');

                const saveChoice = await vscode.window.showInformationMessage(
                    `PHP Live Server found PHP at "${p}". Do you want to save this path to your settings?`,
                    'Save to Workspace Settings',
                    'Save to User Settings',
                    'No, Thanks'
                );

                if (saveChoice === 'Save to Workspace Settings') {
                    await config.update('phpPath', p, vscode.ConfigurationTarget.Workspace);
                    log(`Saved PHP path to workspace settings.`, 'info');
                } else if (saveChoice === 'Save to User Settings') {
                    await config.update('phpPath', p, vscode.ConfigurationTarget.Global);
                    log(`Saved PHP path to user settings.`, 'info');
                }
                
                return p;
            }
        } catch {
            // Path doesn't exist, continue.
        }
    }

    return null;
}

async function initializePhpPath(): Promise<boolean> {
    effectivePhpPath = await findPhpExecutable();
    if (effectivePhpPath) {
        return true;
    } else {
        log('PHP executable could not be found automatically. Please install PHP or set the "php-live-server.phpPath" setting manually.', 'error');
        vscode.window.showErrorMessage('PHP not found. Please set the `php-live-server.phpPath` setting to the absolute path of your PHP executable.');
        return false;
    }
}

// Function to start the WebSocket server
function startWebSocketServer(callback: (assignedPort: number) => void) {
  if (webSocketServer) {
    webSocketServer.close(() => {
      log('Previous WebSocket server closed.');
      webSocketServer = null;
      startWebSocketServer(callback);
    });
    return;
  }

  const wss = new ws.Server({ port: 0 });

  wss.on('listening', () => {
    webSocketPort = (wss.address() as ws.AddressInfo).port;
    log(`WebSocket server is listening on port ${webSocketPort}`, 'info');
    webSocketServer = wss;
    callback(webSocketPort);
  });

  wss.on('connection', (socket: ws.WebSocket) => {
    log('WebSocket client connected.', 'info');
    connectedSockets.add(socket);

    socket.on('close', () => {
      log('WebSocket client disconnected.', 'info');
      connectedSockets.delete(socket);
    });

    socket.on('error', (error: Error) => {
      log(`WebSocket error on client socket: ${error.message}`, 'error');
      // This is usually a client-side issue, so only log it.
    });
  });

  wss.on('error', (error: any) => {
    log(`WebSocket server error: ${error.message}`, 'error');
    if (error.code === 'EADDRINUSE') {
        vscode.window.showErrorMessage(`WebSocket port ${webSocketPort} is already in use. Hot reload might not work. Please try restarting VS Code or ensure the port is free.`);
        log(`Attempted to use WebSocket port: ${webSocketPort}`, 'error');
    }
    webSocketServer = null; // Clear instance on error
  });
}

// Function to start the file watcher
async function startFileWatcher(watchPath: string) {
  if (fileWatcher) {
    log('Closing existing file watcher...', 'info');
    await fileWatcher.close();
    fileWatcher = null;
  }

  log(`Starting file watcher for path: ${watchPath}`, 'info');
  // Watch HTML, PHP, CSS, JS files. Ignore dotfiles, node_modules.
  // Using a more specific glob pattern.
  const globPattern = `${watchPath}/**/*.+(php|html|htm|css|js)`;
  fileWatcher = chokidar.watch(globPattern, {
    ignored: [
        /(^|[\/\\])\../, // ignore dotfiles
        `${watchPath}/node_modules/**`, // ignore node_modules
        `${watchPath}/vendor/**` // ignore vendor folder (common in PHP)
    ],
    persistent: true,
    ignoreInitial: true, // Don't trigger for existing files on startup
    atomic: true // Helps with some file systems and editors that do atomic writes
  });

  fileWatcher.on('change', (filePath) => {
    log(`File ${filePath} has been changed. Triggering reload.`, 'info');
    vscode.window.showInformationMessage(`File changed: ${path.basename(filePath)}. Reloading...`); // Keep this brief for user
    connectedSockets.forEach(socket => {
      if (socket.readyState === ws.OPEN) {
        socket.send('reload');
      }
    });
  });

  fileWatcher.on('error', (error) => {
    log(`File watcher error: ${error.message}`, 'error');
    vscode.window.showWarningMessage("File watcher encountered an error. Hot reload might be affected. Check the 'PHP Live Server' output channel for details.");
  });

  fileWatcher.on('ready', () => {
    log(`File watcher is ready and watching ${globPattern}`, 'info');
    const watchedPaths = fileWatcher?.getWatched();
    // This can be very verbose, so only log if debugging is needed or keep it minimal
    // log(`Initial paths watched: ${JSON.stringify(watchedPaths, null, 2)}`, 'info');
    if (watchedPaths) {
        let count = 0;
        for (const dir in watchedPaths) {
            count += watchedPaths[dir].length;
        }
        log(`Watching ${count} files/directories.`, 'info');
    }
  });
}

// Function to stop all auxiliary servers and watchers
async function stopAuxiliaryServices() {
  if (fileWatcher) {
    log('Stopping file watcher...', 'info');
    await fileWatcher.close();
    fileWatcher = null;
    log('File watcher stopped.', 'info');
  }
  if (webSocketServer) {
    log('Stopping WebSocket server...', 'info');
    // Close all client connections before closing the server
    connectedSockets.forEach(socket => {
        if (socket.readyState === ws.OPEN) {
            socket.terminate(); // Force close if not already closed
        }
    });
    connectedSockets.clear();

    await new Promise<void>((resolve, reject) => {
        if (webSocketServer) {
            webSocketServer.close((err?: Error) => {
                if (err) {
                    log(`Error closing WebSocket server: ${err.message}`, 'error');
                    reject(err);
                } else {
                    log('WebSocket server closed.', 'info');
                    resolve();
                }
                webSocketServer = null;
            });
        } else {
            resolve();
        }
    });
  }
  webSocketPort = 0;
  currentWorkspacePath = null;
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("PHP Live Server");
  log('PHP Live Server extension is activating...', 'info');

  let serverToggleCommand = vscode.commands.registerCommand('extension.startServer', async () => {
    if (serverInstance) {
      log('Stopping PHP server and auxiliary services...', 'info');
      serverInstance.stop();
      serverInstance = null;
      await stopAuxiliaryServices();
      statusBarItem.text = '$(play) Start PHP Server';
      statusBarItem.tooltip = 'Start PHP Live Server';
      vscode.window.showInformationMessage('PHP Server stopped.');
      log('PHP Server and services stopped.', 'info');
    } else {
      log('Attempting to start PHP server...', 'info');

      if (!await initializePhpPath()) {
        // initializePhpPath already shows an error message and logs
        return;
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        log('No active text editor. Aborting server start.', 'warn');
        vscode.window.showErrorMessage('No file open to serve. Please open a file to start the server.');
        return;
      }

      const document = activeEditor.document;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

      if (!workspaceFolder) {
        log('Active file is not part of a workspace. Aborting server start.', 'warn');
        vscode.window.showErrorMessage('File is not part of a workspace. The current file must be part of a workspace to determine the server root. Please open a folder.');
        return;
      }

      const workspaceRootPath = workspaceFolder.uri.fsPath;
      const relativeFilePath = path.relative(workspaceRootPath, document.uri.fsPath);
      currentWorkspacePath = workspaceRootPath;

      const routerScriptPath = vscode.Uri.joinPath(context.extensionUri, 'server_config', 'vscode_php_live_server_router.php').fsPath;

      try {
        startWebSocketServer(async (assignedWsPort) => {
          webSocketPort = assignedWsPort;
          log(`WebSocket server started on port: ${webSocketPort}. Proceeding with PHP server.`, 'info');

          const serverOptions = {
            port: 0,
            hostname: '127.0.0.1',
            base: workspaceRootPath,
            open: false, // We will open manually
            router: routerScriptPath,
            binary: effectivePhpPath!, // Use the discovered PHP path
            env: {
              ...process.env, // Inherit existing env variables
              PHP_LIVE_SERVER_WS_PORT: webSocketPort.toString()
            }
          };

          try {
            serverInstance = await phpServer(serverOptions); // Start PHP server
            if (serverInstance && serverInstance.url) {
              const fileUrl = `${serverInstance.url}/${relativeFilePath.replace(/\\/g, '/')}`;
              vscode.env.openExternal(vscode.Uri.parse(fileUrl));
              const successMsg = `PHP Server started at ${serverInstance.url}. WebSocket for reload on port ${webSocketPort}.`;
              log(successMsg, 'info');
              vscode.window.showInformationMessage(successMsg);
              statusBarItem.text = '$(debug-stop) Stop PHP Server';
              statusBarItem.tooltip = `Stop PHP Live Server (PHP: ${serverInstance.url}, WS: ${webSocketPort})`;

              if (currentWorkspacePath) {
                await startFileWatcher(currentWorkspacePath);
              }
            } else {
              log("PHP server instance or URL is undefined after starting.", 'error');
              throw new Error("PHP Server instance or URL is undefined after starting.");
            }
          } catch (phpServerError: any) {
            log(`Failed to start PHP server: ${phpServerError.message}`, 'error');
            log(`Stack: ${phpServerError.stack}`, 'error');
            vscode.window.showErrorMessage(`Failed to start PHP server. Check the 'PHP Live Server' output channel for details.`);
            serverInstance = null; // Ensure serverInstance is null if startup failed
            await stopAuxiliaryServices(); // Stop WebSocket server as well if PHP server fails
            statusBarItem.text = '$(play) Start PHP Server';
            statusBarItem.tooltip = 'Start PHP Live Server (Error starting PHP)';
          }
        });
      } catch (error: any) { // Catch errors from startWebSocketServer itself or other synchronous parts
        log(`Failed to start auxiliary services (e.g., WebSocket server): ${error.message}`, 'error');
        vscode.window.showErrorMessage(`Failed to start auxiliary services. Check the 'PHP Live Server' output channel for details.`);
        await stopAuxiliaryServices(); // Ensure cleanup
        statusBarItem.text = '$(play) Start PHP Server';
        statusBarItem.tooltip = 'Start PHP Live Server (Error starting services)';
      }
    }
  });

  context.subscriptions.push(serverToggleCommand);

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'extension.startServer';
  statusBarItem.text = '$(play) Start PHP Server';
  statusBarItem.tooltip = 'Start PHP Live Server';
  statusBarItem.show();

  context.subscriptions.push(statusBarItem);
}

export async function deactivate() { // Make deactivate async
  if (serverInstance) {
    serverInstance.stop();
    serverInstance = null;
    console.log('PHP Live Server stopped due to extension deactivation.');
  }
  await stopAuxiliaryServices(); // Ensure watcher and WebSocket server are also stopped
  console.log('PHP Live Server extension deactivated.');
}
