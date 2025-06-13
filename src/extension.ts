import * as vscode from 'vscode';
import { phpServer } from 'php-server';
import * as path from 'path';
import * as chokidar from 'chokidar';
import * as ws from 'ws';
import { exec } from 'child_process';

// Module-level variables
let outputChannel: vscode.OutputChannel;
let serverInstance: { stop: () => void; url: string; [key: string]: any } | null = null;
let statusBarItem: vscode.StatusBarItem;
let fileWatcher: chokidar.FSWatcher | null = null;
let webSocketServer: ws.Server | null = null;
let webSocketPort: number = 0;
const connectedSockets: Set<ws.WebSocket> = new Set();
let currentWorkspacePath: string | null = null;
let phpPathVerified = false; // Flag to check PHP path only once

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


// Function to verify PHP path
async function verifyPHPPath(): Promise<boolean> {
    if (phpPathVerified) return true;

    return new Promise((resolve) => {
        exec('php -v', (error, stdout, stderr) => {
            if (error) {
                log('PHP executable not found or `php -v` failed. Please ensure PHP is installed and in your system PATH.', 'error');
                log(`'php -v' error: ${stderr || error.message}`, 'error');
                vscode.window.showErrorMessage('PHP not found. Please install PHP and add it to your PATH. Check the "PHP Live Server" output for details.');
                phpPathVerified = false; // Explicitly set, though it's the default
                resolve(false);
            } else {
                log('PHP path verified successfully.', 'info');
                log(`PHP version: ${stdout.split('\n')[0]}`, 'info'); // Log first line of php -v
                phpPathVerified = true;
                resolve(true);
            }
        });
    });
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

  wss.on('connection', (socket) => {
    log('WebSocket client connected.', 'info');
    connectedSockets.add(socket);

    socket.on('close', () => {
      log('WebSocket client disconnected.', 'info');
      connectedSockets.delete(socket);
    });

    socket.on('error', (error) => {
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
            webSocketServer.close((err) => {
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

      if (!await verifyPHPPath()) {
        // verifyPHPPath already shows an error message and logs
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
