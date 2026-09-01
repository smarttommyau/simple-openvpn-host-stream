import { Request, Response, NextFunction } from 'express';

// =============================================================================
// Global Connection Tracking for HLS Stream
// Tracks total last access time and distinct connections (no path tracking)
// Only counts active connections within the timeout window (60s)
// =============================================================================

const TIMEOUT_WINDOW_MS = 60 * 1000; // 60 seconds in milliseconds

interface GlobalConnectionState {
  lastAccessTime: number | null;
  distinctConnections: Map<string, number>; // clientId -> last request timestamp
}

const GLOBAL_CONNECTION_STATE: GlobalConnectionState = {
  lastAccessTime: null,
  distinctConnections: new Map(),
};

// Middleware to track ALL connections (not path-specific)
export function hlsConnectionTracker(req: Request, res: Response, next: NextFunction): void {
  if(! (req.path.startsWith('/hls/') || req.path === '/hls') ) {
    // Not an HLS request, skip tracking
    return next();
  }

  // Determine client identifier (IP or X-Forwarded-For)
  const forwardedFor = req.headers['x-forwarded-for'] as string | string[];
  const clientId = req.ip || (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) || 'unknown';
  const now = Date.now();

  // Update global last access time
  GLOBAL_CONNECTION_STATE.lastAccessTime = now;

  // Track distinct connection with timestamp of last request
  if (!GLOBAL_CONNECTION_STATE.distinctConnections.has(clientId)) {
    GLOBAL_CONNECTION_STATE.distinctConnections.set(clientId, now);
  } else {
    // Update the last request timestamp for this client
    GLOBAL_CONNECTION_STATE.distinctConnections.set(clientId, now);
  }

  // Log for debugging
  console.log(
    `[hls-tracker] ${req.method} ${req.path} - ` +
    `Last access: ${new Date(now).toISOString()}, ` +
    `Distinct connections: ${GLOBAL_CONNECTION_STATE.distinctConnections.size}`
  );

  next();
}

// Get the last access time (global, no path)
export function getLastAccessTime(): number | null {
  return GLOBAL_CONNECTION_STATE.lastAccessTime;
}

// Get the number of active distinct connections within timeout window (global)
export function getActiveDistinctConnectionsCount(): number {
  const now = Date.now();
  let count = 0;

  // Only count connections that have requested within the last 60 seconds
  for (const [clientId, lastRequestTime] of GLOBAL_CONNECTION_STATE.distinctConnections.entries()) {
    if (now - lastRequestTime <= TIMEOUT_WINDOW_MS) {
      count++;
    } else {
      // Remove stale connection (older than 60s)
      GLOBAL_CONNECTION_STATE.distinctConnections.delete(clientId);
    }
  }

  return count;
}

// Get all active distinct connections within timeout window (global)
export function getAllActiveDistinctConnections(): Map<string, number> {
  const now = Date.now();
  const allConnections = new Map<string, number>();

  for (const [clientId, lastRequestTime] of GLOBAL_CONNECTION_STATE.distinctConnections.entries()) {
    if (now - lastRequestTime <= TIMEOUT_WINDOW_MS) {
      allConnections.set(clientId, lastRequestTime);
    } else {
      // Remove stale connection
      GLOBAL_CONNECTION_STATE.distinctConnections.delete(clientId);
    }
  }

  return allConnections;
}

// Get total active distinct connections count (global)
export function getTotalActiveDistinctConnectionsCount(): number {
  return getAllActiveDistinctConnections().size;
}

// Clear all tracking data (used when stream stops or on server shutdown)
export function clearAllTracking(): void {
  GLOBAL_CONNECTION_STATE.lastAccessTime = null;
  GLOBAL_CONNECTION_STATE.distinctConnections.clear();
}
