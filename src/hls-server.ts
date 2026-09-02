import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { spawn } from 'child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// =============================================================================
// HLS Server Worker - Handles all stream management (ffmpeg + streamlink)
// Communicates with main thread via parentPort using state messages
// NO Express server here - only spawn process management
// =============================================================================

const STATE_IDLE = 'idle';
const STATE_STARTING = 'starting';
const STATE_STARTED = 'started';
const STATE_CHANGING_CHANNEL = 'changing-channel';

interface StreamState {
  status: typeof STATE_IDLE | typeof STATE_STARTING | typeof STATE_STARTED | typeof STATE_CHANGING_CHANNEL;
}

// =============================================================================
// Configuration - Read ONLY from environment variables (NOT from .env file)
// =============================================================================
const HLS_DIR = join(__dirname, '..', 'public', 'hls');
const TIMEOUT_WINDOW_MS = 60 * 1000; // 60 seconds timeout window
const CHECK_INTERVAL_MS = 15 * 1000; // Check every 15 seconds

// Ensure HLS directory exists and is clean
if (!existsSync(HLS_DIR)) {
  mkdirSync(join(__dirname, '..', 'public'), { recursive: true });
  mkdirSync(HLS_DIR, { recursive: true });
} else {
  const files = readdirSync(HLS_DIR);
  for (const file of files) {
    try {
      unlinkSync(join(HLS_DIR, file));
    } catch (err) {
      console.error('[hls-server] Error deleting HLS file:', err);
    }
  }
}

// =============================================================================
// Application State
// =============================================================================
let streamlinkProcess: ReturnType<typeof spawn> | null = null;
let ffmpegProcess: ReturnType<typeof spawn> | null = null;
let isStreaming = false;
let targetUrl: string | undefined = workerData.url;

// =============================================================================
// Start Streaming When First User Connects (Background mode)
// =============================================================================
async function startStreaming(): Promise<void> {
  if (isStreaming) {
    console.log('[hls-server] Stream already active');
    return;
  }

  console.log('[hls-server] Starting stream processes...');
  isStreaming = true;

  // 1. Spawn Streamlink (Outputs raw stream to stdout)
  const streamlink = spawn('streamlink', ['--stdout', targetUrl!, 'best']);

  // 2. Spawn FFmpeg - Output HLS format for browser compatibility
  // All output goes to hls/ directory which is served by express.static in main thread
  const ffmpeg = spawn('ffmpeg', [
    '-re',
    '-i', 'pipe:0',              // Read input from Streamlink's pipe
    '-c:v', 'copy',              // Copy video codec (H.264) without re-encoding
    '-c:a', 'aac',               // Ensure audio is AAC format
    '-f', 'hls',                 // Output HLS format (HTTP Live Streaming)
    '-hls_time', '3',            // Segment duration in seconds
    '-hls_list_size', '5',       // Keep only last 5 segments in playlist
    '-hls_flags', 'delete_segments', // Automatically delete old segments
    join(HLS_DIR, 'stream.m3u8') // Output to playlist file in hls/ directory
  ]);

  console.log('[hls-server] Streamlink process started');
  console.log('[hls-server] FFmpeg process started');

  // Track the primary streaming container process
  streamlinkProcess = ffmpeg;
  ffmpegProcess = ffmpeg;

  // 3. PIPE STREAMLINK TO FFMPEG
  console.log('[hls-server] Piping streamlink.stdout to ffmpeg.stdin');
  streamlink.stdout.pipe(ffmpeg.stdin);

  // 4. CAPTURE CLEAN FFMPEG LOGS (Text only)
  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        console.log('[ffmpeg status]', line.trim());
      }
    }
  });

  // 5. CAPTURE CLEAN STREAMLINK LOGS (Text only)
  streamlink.stderr.on('data', (chunk: Buffer) => {
    const err = chunk.toString().trim();
    if (err && !err.includes('Available streams')) {
      console.log('[streamlink info]', err);
    }
  });

  // 6. Handle process lifecycles and cleanups
  streamlink.on('error', (err) => console.error('[streamlink error]', err.message));
  ffmpeg.on('error', (err) => console.error('[ffmpeg error]', err.message));

  ffmpeg.on('close', async (code) => {
    console.log(`[hls-server] FFmpeg process exited with code ${code}`);
    if (streamlinkProcess) {
      console.log('[hls-server] Sending SIGTERM to streamlink on ffmpeg close');
      streamlinkProcess.kill('SIGTERM');
      streamlinkProcess = null;
    }
    await endAllConnections();
  });

  // Monitor ffmpeg for output - wait until first segment is written
  let stdoutBufferLength = 0;
  
  ffmpeg.stdout.on('data', (chunk: Buffer) => {
    stdoutBufferLength += chunk.length;
    console.log(`[hls-server] FFmpeg stdout received ${chunk.length} bytes. Total buffered: ${stdoutBufferLength} bytes`);
    
    if (stdoutBufferLength > 1024) {
      console.log('[hls-server] FFmpeg is producing video data');
    }
  });

  // Timeout check - if no data after 5 seconds, log warning
  let timeoutCheck = setTimeout(() => {
    if (stdoutBufferLength === 0) {
      console.warn('[hls-server] WARNING: No ffmpeg output after 5 seconds. Check stream availability.');
    } else {
      clearTimeout(timeoutCheck);
    }
  }, 5000);

  // Cleanup timeout on process close
  ffmpeg.on('close', () => {
    if (timeoutCheck) clearTimeout(timeoutCheck);
  });
}

// =============================================================================
// End All Connections and Stop Streaming
// =============================================================================
async function endAllConnections(): Promise<void> {
  console.log('[hls-server] Ending all connections...');
  
  // Store references before killing - we need to wait for them to exit
  const streamlinkRef = streamlinkProcess;
  const ffmpegRef = ffmpegProcess;
  
  
  // Wait for both processes to actually exit before clearing HLS directory
  const waitForExit = async (): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      let streamlinkExited = false;
      let ffmpegExited = false;
      
      // Set timeout for process termination (10 seconds)
      const timeoutId = setTimeout(() => {
        console.error('[hls-server] Processes did not exit within timeout, forcing cleanup');
        streamlinkRef?.kill('SIGKILL');
        ffmpegRef?.kill('SIGKILL');
        resolve();
      }, 10000);
      
      // Wait for streamlink to exit
      if (streamlinkRef) {
        streamlinkRef.on('exit', (code) => {
          console.log(`[hls-server] Streamlink exited with code ${code}`);
          streamlinkExited = true;
          
          // If both have exited, resolve the promise
          if (streamlinkExited && ffmpegExited) {
            clearTimeout(timeoutId);
            resolve();
          }
        });
      } else {
        // Already null, check if ffmpeg has exited
        if (ffmpegRef) {
          ffmpegRef.on('exit', (code) => {
            console.log(`[hls-server] FFmpeg exited with code ${code}`);
            ffmpegExited = true;
            
            // If both have exited, resolve the promise
            if (streamlinkExited && ffmpegExited) {
              clearTimeout(timeoutId);
              resolve();
            }
          });
        } else {
          // Both already null, resolve immediately
          clearTimeout(timeoutId);
          resolve();
        }
      }
      
      // Wait for ffmpeg to exit
      if (ffmpegRef) {
        ffmpegRef.on('exit', (code) => {
          console.log(`[hls-server] FFmpeg exited with code ${code}`);
          ffmpegExited = true;
          
          // If both have exited, resolve the promise
          if (streamlinkExited && ffmpegExited) {
            clearTimeout(timeoutId);
            resolve();
          }
        });
      } else {
        // Already null, check if streamlink has exited
        if (streamlinkRef) {
          streamlinkRef.on('exit', (code) => {
            console.log(`[hls-server] Streamlink exited with code ${code}`);
            streamlinkExited = true;
            
            // If both have exited, resolve the promise
            if (streamlinkExited && ffmpegExited) {
              clearTimeout(timeoutId);
              resolve();
            }
          });
        } else {
          // Both already null, resolve immediately
          clearTimeout(timeoutId);
          resolve();
        }
      }
    });
  };
  
  // Clear HLS directory after processes have exited
  const wt =  waitForExit();
  // Stop both processes with SIGTERM
  if (streamlinkRef) {
    console.log('[hls-server] Sending SIGTERM to streamlink');
    streamlinkRef.kill('SIGTERM');
  }
  if (ffmpegRef) {
    console.log('[hls-server] Sending SIGTERM to ffmpeg');
    ffmpegRef.kill('SIGTERM');
  }

  await wt;

  // Clear references
  streamlinkProcess = null;
  ffmpegProcess = null;
  
  const files = readdirSync(HLS_DIR);
  for (const file of files) {
    try {
      unlinkSync(join(HLS_DIR, file));
    } catch (err) {
      console.error('[hls-server] Error deleting HLS file:', err);
    }
  }
  
  isStreaming = false;
}

// =============================================================================
// Graceful Shutdown Handlers
// =============================================================================
process.on('SIGTERM', async () => {
  console.log('[hls-server] SIGTERM received, shutting down gracefully...');
  await endAllConnections();
  if (streamlinkProcess) streamlinkProcess.kill('SIGTERM');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[hls-server] SIGINT received, shutting down gracefully...');
  await endAllConnections();
  if (streamlinkProcess) streamlinkProcess.kill('SIGTERM');
  process.exit(0);
});

// =============================================================================
// Worker Message Handler - Communicates with main thread via parentPort
// =============================================================================
if (!isMainThread && parentPort) {
  // Track last connection time from main thread
  let lastConnectionTime: number | null = null;
  let checkIntervalId: NodeJS.Timeout | null = null;

  parentPort.on('message', async (msg: any) => {
    console.log('[hls-server] Received message from main thread:', msg);
    
    if (msg.type === 'start') {
      const url = msg.url || workerData.url;
      if (!url) {
        parentPort?.postMessage({ type: 'error', payload: { message: 'No URL provided' } });
        return;
      }
      
      targetUrl = url;
      console.log('[hls-server] Starting stream with URL:', url);
      
      // Initialize lastConnectionTime to current time when starting stream
      // This prevents Infinity on first check since no previous connection exists yet
      lastConnectionTime = Date.now();
      
      // Send state change to main thread
      parentPort?.postMessage({
        type: 'state',
        payload: { status: STATE_STARTING }
      });
      
      startStreaming();
    }
    else if (msg.type === 'stop') {
      console.log('[hls-server] Stopping stream');
      await endAllConnections();
      
      // Send state change to main thread
      parentPort?.postMessage({
        type: 'state',
        payload: { status: STATE_IDLE }
      });

      // Clear the check interval
      if (checkIntervalId) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
      }
    }
    else if (msg.type === 'change-channel') {
      console.log('[hls-server] Received change-channel request. Killing current stream and restarting with new URL...');
      
      // Kill current stream processes
      await endAllConnections();
      
      // Send state change to main thread indicating channel change in progress
      parentPort?.postMessage({
        type: 'state',
        payload: { status: STATE_CHANGING_CHANNEL }
      });
      
      // Use new URL from message if provided, otherwise use workerData.url
      const newUrl = msg.url || workerData.url;
      if (!newUrl) {
        console.error('[hls-server] No URL provided for channel change');
        parentPort?.postMessage({ type: 'error', payload: { message: 'No URL provided for channel change' } });
        return;
      }
      
      targetUrl = newUrl;
      console.log('[hls-server] Starting new stream with URL:', newUrl);
      
      // Initialize lastConnectionTime to current time when starting new stream
      lastConnectionTime = Date.now();
      
      // Send state change to main thread
      parentPort?.postMessage({
        type: 'state',
        payload: { status: STATE_STARTING }
      });
      
      startStreaming();
    }
    else if (msg.type === 'status') {
      const state: StreamState = {
        status: isStreaming ? STATE_STARTED : STATE_IDLE
      };
      parentPort?.postMessage({
        type: 'state',
        payload: state
      });
    }
    else if (msg.type === 'set-last-connection') {
      // Main thread sends last connection time from middleware
      lastConnectionTime = msg.lastConnectionTime;
      console.log(`[hls-server] Last connection time set to: ${lastConnectionTime ? new Date(lastConnectionTime).toISOString() : 'null'}`);
    }
    else if (msg.type === 'get-last-connection') {
      // Worker asks main thread for last connection time
      const now = Date.now();
      const timeSinceLastConnection = lastConnectionTime ? now - lastConnectionTime : Infinity;

      console.log(`[hls-server] Checking idle: ${timeSinceLastConnection > TIMEOUT_WINDOW_MS ? 'IDLE' : 'ACTIVE'} (${Math.round(timeSinceLastConnection/1000)}s since last connection)`);

      if (timeSinceLastConnection > TIMEOUT_WINDOW_MS) {
        console.log('[hls-server] No connections for 60+ seconds. Stopping stream...');
        
        // Stop the stream
        await endAllConnections();
        
        // Send state change to main thread
        parentPort?.postMessage({
          type: 'state',
          payload: { status: STATE_IDLE }
        });

        // Clear the check interval
        if (checkIntervalId) {
          clearInterval(checkIntervalId);
          checkIntervalId = null;
        }
      } else {
        console.log(`[hls-server] Active connections detected. Last connection: ${lastConnectionTime ? new Date(lastConnectionTime).toISOString() : 'null'}`);
      }
    }
  });

  // Periodic check every 15 seconds - ask main thread for last connection time
  if (!isMainThread) {
    const startCheckInterval = () => {
      checkIntervalId = setInterval(() => {
        console.log(`[hls-server] Checking for idle connections...`);

        if (!isStreaming) {
          console.log('[hls-server] Not streaming, skipping check');
          return;
        }

        // Ask main thread for last connection time
        parentPort?.postMessage({ type: 'get-last-connection' });
      }, CHECK_INTERVAL_MS);
    };

    startCheckInterval();

    // Cleanup on exit
    process.on('SIGTERM', () => {
      console.log('[hls-server] SIGTERM received, cleaning up...');
      if (checkIntervalId) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
      }
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('[hls-server] SIGINT received, cleaning up...');
      if (checkIntervalId) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
      }
      process.exit(0);
    });
  }
}

// =============================================================================
// Export for testing
// =============================================================================
export { STATE_IDLE, STATE_STARTING, STATE_STARTED, STATE_CHANGING_CHANNEL };
