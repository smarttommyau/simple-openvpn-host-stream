import express, { Request, Response, NextFunction } from 'express';
import { Worker } from 'worker_threads';
import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { hlsConnectionTracker, getActiveDistinctConnectionsCount, getTotalActiveDistinctConnectionsCount, clearPathTracking, getLastAccessTime } from './middleware/connection-tracker';

// =============================================================================
// Configuration - Read ONLY from environment variables (NOT from .env file)
// =============================================================================
dotenv.config({ path: join(__dirname, '..', '.env') }); // Load .env file for local development
const PORT = parseInt(process.env.PORT || '8080', 10);

// Read STREAM_URL ONLY from environment variable (NOT from .env file)
const TARGET_URL = process.env.STREAM_URL || undefined;
if (!TARGET_URL) {
  console.error('[app] ERROR: STREAM_URL environment variable is not set!');
  console.error('[app] Please set STREAM_URL to the target streaming site URL.');
  process.exit(1);
}

// =============================================================================
// Application State
// =============================================================================
let isStreaming = false;
const HLS_DIR = join(__dirname, '..', 'public', 'hls');

// Ensure HLS directory exists and is clean
if (!existsSync(HLS_DIR)) {
  // Create parent directories first, then hls subdirectory
  mkdirSync(join(__dirname, '..', 'public'), { recursive: true });
  mkdirSync(HLS_DIR, { recursive: true });
} else {
  // Clear old files from previous runs
  const files = readdirSync(HLS_DIR);
  for (const file of files) {
    unlinkSync(join(HLS_DIR, file));
  }
}

// =============================================================================
// HLS Server Worker - Handles all stream management (ffmpeg + streamlink)
// Communicates with main thread via parentPort using state messages
// =============================================================================
let hlsWorker: Worker | null = null;

function createHlsWorker(): Worker {
  const workerPath = join(__dirname, '..', 'dist', 'hls-server.js');
  console.log('[app] Creating HLS server worker:', workerPath);
  
  const worker = new Worker(workerPath, {
    workerData: { url: TARGET_URL }
  });

  // Handle worker messages (state updates from hls-server)
  worker.on('message', (msg: any) => {
    console.log('[app] Received message from HLS worker:', msg);
    
    if (msg.type === 'state') {
      const state = msg.payload;
      console.log(`[app] HLS Worker state changed to: ${state.status}`);
      
      // Update health endpoint state based on worker state
      if (state.status === 'started') {
        isStreaming = true;
      } else if (state.status === 'idle') {
        isStreaming = false;
      }
    }
    else if (msg.type === 'get-last-connection') {
      // Worker asks main thread for last connection time
      const now = Date.now();
      const lastAccessTime = getLastAccessTime('/hls/');
      const timeSinceLastConnection = lastAccessTime ? now - lastAccessTime : Infinity;

      console.log(`[app] Last connection check: ${timeSinceLastConnection > 60000 ? 'IDLE' : 'ACTIVE'} (${Math.round(timeSinceLastConnection/1000)}s since last connection)`);

      if (timeSinceLastConnection > 60000) {
        console.log('[app] No connections for 60+ seconds. Stopping stream...');
        
        // Send stop message to worker
        hlsWorker?.postMessage({ type: 'stop' });
        
        isStreaming = false;
      } else {
        console.log(`[app] Active connections detected. Last connection: ${lastAccessTime ? new Date(lastAccessTime).toISOString() : 'null'}`);
      }
    }
  });

  // Handle worker errors
  worker.on('error', (err) => {
    console.error('[app] HLS Worker error:', err);
  });

  // Handle worker exit
  worker.on('exit', (code) => {
    console.log(`[app] HLS Worker exited with code ${code}`);
    if (code !== null) {
      isStreaming = false;
      endAllConnections();
    }
  });

  return worker;
}

// =============================================================================
// Express App
// =============================================================================
const app = express();
app.use(express.json()); // Parse JSON request bodies
app.use(hlsConnectionTracker); // Track connections to /hls/ directory

// Send last connection time to worker after each request
const sendLastConnectionToWorker = (req: Request, res: Response, next: NextFunction) => {
  const lastAccessTime = getLastAccessTime('/hls/');
  if (lastAccessTime && hlsWorker) {
    hlsWorker.postMessage({ type: 'set-last-connection', lastConnectionTime: lastAccessTime });
  }
  next();
};

app.use(express.static(join(__dirname, '..', 'public')));
app.use(sendLastConnectionToWorker); // Send last connection time to worker after each request

// =============================================================================
// Health Check Endpoint - Reports current stream state via worker
// =============================================================================
app.get('/health', (req: Request, res: Response) => {
  const state = isStreaming ? 'streaming' : 'idle';
  
  // Send state to worker for update
  if (hlsWorker) {
    hlsWorker.postMessage({ type: 'status' });
  }
  
  const timeoutSeconds = parseInt(process.env.TIMEOUT_SECONDS || '60', 10);
  const distinctConnections = getActiveDistinctConnectionsCount('/hls/');
  const lastAccessTime = getLastAccessTime('/hls/') ? new Date(getLastAccessTime('/hls/')!).toISOString() : null;
  
  res.json({
    status: state,
    connections: distinctConnections,
    timeoutSeconds: timeoutSeconds,
    lastAccessTime: lastAccessTime
  });
});

// =============================================================================
// Handle idle-detected message from hls-server worker
// =============================================================================
if (hlsWorker) {
  const workerMessageHandler = (msg: any) => {
    console.log('[app] Received message from HLS worker:', msg);
    
    if (msg.type === 'state') {
      const state = msg.payload;
      console.log(`[app] HLS Worker state changed to: ${state.status}`);
      
      // Update health endpoint state based on worker state
      if (state.status === 'started') {
        isStreaming = true;
      } else if (state.status === 'idle') {
        isStreaming = false;
      }
    }
    
    // Handle idle-detected message from timeout check
    if (msg.type === 'idle-detected') {
      console.log(`[app] Idle detected! Stopping stream...`);
      
      // Kill worker - hls-server handles cleanup internally
      if (hlsWorker) {
        hlsWorker.terminate();
        hlsWorker = null;
      }
      
      isStreaming = false;
    }
  };
  
  (hlsWorker as any).on('message', workerMessageHandler);
}

// =============================================================================
// Start Stream Endpoint - Starts streaming via worker message
// =============================================================================
app.post('/start-stream', (req: Request, res: Response) => {
  console.log('[app] [startStream] Received POST request to /start-stream');
  
  const url = req.body.url || TARGET_URL;
  
  if (!hlsWorker) {
    console.log('[app] [startStream] Creating HLS worker...');
    hlsWorker = createHlsWorker();
  }
  
  // Send start message to worker with URL
  hlsWorker.postMessage({ type: 'start', url });
  
  // Return immediate success response
  res.json({
    ready: false,
    message: 'Stream starting in background. Use /hls/stream.m3u8 to access the stream.',
    timestamp: new Date().toISOString()
  });
});

// =============================================================================
// Stream Ready Check Endpoint - Polling endpoint for frontend
// =============================================================================
app.get('/stream-ready', (req: Request, res: Response) => {
  console.log('[app] [checkReady] Received request for /stream-ready');
  
  if (!hlsWorker) {
    res.status(503).json({
      ready: false,
      message: 'No stream active. Please POST to /start-stream first.',
      timestamp: new Date().toISOString()
    });
    return;
  }
  
  // Ask worker for status
  hlsWorker.postMessage({ type: 'status' });
  
  if (isStreaming) {
    const playlistPath = join(HLS_DIR, 'stream.m3u8');
    if (existsSync(playlistPath)) {
      // Check if playlist has content (stream is ready)
      const stats = require('fs').statSync(playlistPath);
      console.log('[app] [checkReady] Stream is ready! Playlist size:', stats.size, 'bytes');
      
      res.json({
        ready: true,
        timestamp: new Date().toISOString()
      });
    } else {
      // Stream is active but playlist not ready yet
      console.log('[app] [checkReady] Stream is active but playlist not ready yet');
      
      res.status(503).json({
        ready: false,
        message: 'Stream is starting up...',
        timestamp: new Date().toISOString()
      });
    }
  } else {
    // No stream active yet
    console.log('[app] [checkReady] No stream active');
    
    res.status(503).json({
      ready: false,
      message: 'No stream active. Please POST to /start-stream first.',
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================================================
// Stop Stream Endpoint - Stops streaming via worker message
// =============================================================================
app.post('/stop-stream', (req: Request, res: Response) => {
  console.log('[app] [stopStream] Received POST request to /stop-stream');
  
  if (!hlsWorker) {
    console.log('[app] [stopStream] No worker running');
    res.json({
      stopped: false,
      message: 'No stream active to stop',
      timestamp: new Date().toISOString()
    });
    return;
  }
  
  // Send stop message to worker
  hlsWorker.postMessage({ type: 'stop' });
  
  res.json({
    stopped: true,
    message: 'Stream stopped successfully',
    timestamp: new Date().toISOString()
  });
});

// =============================================================================
// Get Viewers Endpoint - For frontend polling (every 5 seconds)
// =============================================================================
app.get('/get-viewers', (req: Request, res: Response) => {
  console.log('[app] [getViewers] Received request for /get-viewers');
  
  const distinctConnections = getActiveDistinctConnectionsCount('/hls/');
  const lastAccessTime = getLastAccessTime('/hls/') ? new Date(getLastAccessTime('/hls/')!).toISOString() : null;
  
  res.json({
    viewers: distinctConnections,
    lastAccessTime: lastAccessTime,
    timestamp: new Date().toISOString()
  });
});

// =============================================================================
// End All Connections and Stop Streaming (cleanup)
// =============================================================================
function endAllConnections(): void {
  console.log('[app] Ending all connections...');
  
  // Kill worker if exists - hls-server handles HLS cleanup internally
  if (hlsWorker) {
    hlsWorker.terminate();
    hlsWorker = null;
  }
  
  isStreaming = false;
}

// =============================================================================
// Graceful Shutdown Handlers
// =============================================================================
process.on('SIGTERM', () => {
  console.log('[app] SIGTERM received, shutting down gracefully...');
  endAllConnections();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[app] SIGINT received, shutting down gracefully...');
  endAllConnections();
  process.exit(0);
});

// =============================================================================
// Start Server
// =============================================================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[app] Stream proxy server listening on port ${PORT}`);
  
  if (TARGET_URL) {
    console.log(`[app] Target stream URL: ${TARGET_URL}`);
  } else {
    console.error('[app] WARNING: STREAM_URL not set in environment! Stream will not work.');
    console.error('[app] Set STREAM_URL environment variable before starting the server.');
  }
});

// =============================================================================
// Export for testing
// =============================================================================
export { server };
