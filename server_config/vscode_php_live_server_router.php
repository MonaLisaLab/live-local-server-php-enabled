<?php
// vscode_php_live_server_router.php

$wsPort = getenv('PHP_LIVE_SERVER_WS_PORT');

$requestedFile = $_SERVER['SCRIPT_FILENAME'];
$publicDir = $_SERVER['DOCUMENT_ROOT']; // Base path from php-server

// It's important that $requestedFile is correctly resolved by the built-in server
// based on $publicDir and the request URI. If not, manual construction is needed.
// For example: $requestedFile = $publicDir . $_SERVER['SCRIPT_NAME'];
// However, SCRIPT_FILENAME should usually be correct if the server is configured properly.

// Security: Ensure requested file is within the public directory.
// realpath() resolves symbolic links and '..'
if (strpos(realpath($requestedFile), realpath($publicDir)) !== 0) {
    // Or handle as a 404, or log an error.
    // This is a basic security check.
    error_log("Attempt to access file outside of public directory: " . $requestedFile);
    http_response_code(404);
    echo "File not found.";
    return true;
}


if (is_dir($requestedFile)) {
    $indexPhp = $requestedFile . DIRECTORY_SEPARATOR . 'index.php';
    $indexHtml = $requestedFile . DIRECTORY_SEPARATOR . 'index.html';

    if (file_exists($indexPhp)) {
        $requestedFile = $indexPhp;
    } elseif (file_exists($indexHtml)) {
        $requestedFile = $indexHtml;
    } else {
        // Let built-in server handle directory listing or 404 if no index file.
        // However, usually a router script means you handle all responses or return false.
        // If we return false, the built-in server might try to list directory contents if enabled, or 404.
        return false;
    }
}

$extension = strtolower(pathinfo($requestedFile, PATHINFO_EXTENSION));

// Serve non-PHP/HTML files directly if they exist
if ($extension !== 'php' && $extension !== 'html' && $extension !== 'htm') {
    if (file_exists($requestedFile)) {
        return false; // Let the built-in server handle static files like CSS, JS, images.
    }
}

// Handle PHP, HTML, HTM files
if (file_exists($requestedFile) && ($extension === 'php' || $extension === 'html' || $extension === 'htm')) {
    header('Content-Type: text/html; charset=utf-8');

    ob_start();
    // Change directory to the script's directory to resolve relative includes correctly
    $scriptDir = dirname($requestedFile);
    chdir($scriptDir);

    if ($extension === 'php') {
        require $requestedFile; // Use require for PHP files
    } else { // html or htm
        include $requestedFile; // Use include for HTML files (to process any PHP within them)
    }
    $output = ob_get_clean();

    if ($wsPort) {
        $clientJs = <<<JS
        <script data-php-live-server-ws-port="{$wsPort}">
            (function() {
                const wsPort = document.currentScript.getAttribute('data-php-live-server-ws-port');
                if (!wsPort) {
                    console.warn('PHP Live Server: WebSocket port not specified for hot reload.');
                    return;
                }
                const socket = new WebSocket('ws://127.0.0.1:' + wsPort);
                socket.onopen = function() {
                    console.log('PHP Live Server: Hot reload WebSocket connected on port ' + wsPort + '.');
                };
                socket.onmessage = function(event) {
                    if (event.data === 'reload') {
                        console.log('PHP Live Server: Reloading page...');
                        location.reload();
                    }
                };
                socket.onerror = function(error) {
                    console.error('PHP Live Server: WebSocket error:', error);
                };
                socket.onclose = function() {
                    console.log('PHP Live Server: Hot reload WebSocket disconnected.');
                };
            })();
        </script>
JS;
        // Inject script before </body> if it exists, otherwise append to output.
        $bodyEndTag = '</body>';
        $bodyEndPos = strripos($output, $bodyEndTag);
        if ($bodyEndPos !== false) {
            $output = substr_replace($output, $clientJs . PHP_EOL . $bodyEndTag, $bodyEndPos, strlen($bodyEndTag));
        } else {
            $output .= PHP_EOL . $clientJs;
        }
    }

    echo $output;
    return true; // Signal that the request was handled
}

// If file not found or not a type we handle, return false for built-in server (404).
return false;
?>
