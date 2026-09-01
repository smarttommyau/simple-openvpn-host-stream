import { Request, Response, NextFunction } from 'express';

// =============================================================================
// Connection Tracking Middleware for /hls/ directory
// Tracks last access time and distinct connections to implement timeout logic
// Only counts active connections within the timeout window (60s)
// =============================================================================

const TIMEOUT_WINDOW_MS = 60 * 1000; // 60 seconds in milliseconds

interface ConnectionTrackerState {
  lastAccessTime: number | null;
  distinctConnections: Map<string, number>; // clientId -> last request timestamp
}

const CONNECTION_TRACKER_STATE = new Map<string, ConnectionTrackerState>();

// Middleware to track connections to /hls/ directory
export function hlsConnectionTracker(req: Request, res: Response, next: NextFunction): void {
  // Only track requests to /hls/ directory
  if (req.path.startsWith('/hls/')) {
    const forwardedFor = req.headers['x-forwarded-for'] as string | string[];
    const clientId = req.ip || (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) || 'unknown';
    const now = Date.now();

    let state = CONNECTION_TRACKER_STATE.get(req.path) || {
      lastAccessTime: null,
      distinctConnections: new Map(),
    };

    // Update last access time for this path
    state.lastAccessTime = now;

    // Track distinct connection with timestamp of last request
    if (!state.distinctConnections.has(clientId)) {
      state.distinctConnections.set(clientId, now);
    } else {
      // Update the last request timestamp for this client
      state.distinctConnections.set(clientId, now);
    }

    CONNECTION_TRACKER_STATE.set(req.path, state);

    // Log for debugging
    console.log(
      `[hls-tracker] ${req.method} ${req.path} - ` +
      `Last access: ${new Date(now).toISOString()}, ` +
      `Distinct connections: ${state.distinctConnections.size}`
    );
  }

  next();
}

// Get the last access time for a specific path
export function getLastAccessTime(path: string): number | null {
  const state = CONNECTION_TRACKER_STATE.get(path);
  return state?.lastAccessTime || null;
}

// Get the number of active distinct connections within timeout window for a specific path
export function getActiveDistinctConnectionsCount(path: string): number {
  const state = CONNECTION_TRACKER_STATE.get(path);
  if (!state) return 0;

  const now = Date.now();
  let count = 0;

  // Only count connections that have requested within the last 60 seconds
  for (const [clientId, lastRequestTime] of state.distinctConnections.entries()) {
    if (now - lastRequestTime <= TIMEOUT_WINDOW_MS) {
      count++;
    } else {
      // Remove stale connection (older than 60s)
      state.distinctConnections.delete(clientId);
    }
  }

  return count;
}

// Get all active distinct connections across all paths within timeout window
export function getAllActiveDistinctConnections(): Map<string, number> {
  const now = Date.now();
  const allConnections = new Map<string, number>();

  for (const [path, state] of CONNECTION_TRACKER_STATE.entries()) {
    for (const [clientId, lastRequestTime] of state.distinctConnections.entries()) {
      if (now - lastRequestTime <= TIMEOUT_WINDOW_MS) {
        const key = `${path}:${clientId}`;
        allConnections.set(key, lastRequestTime);
      } else {
        // Remove stale connection
        state.distinctConnections.delete(clientId);
      }
    }
  }

  return allConnections;
}

// Get total active distinct connections count across all paths
export function getTotalActiveDistinctConnectionsCount(): number {
  return getAllActiveDistinctConnections().size;
}

// Clear tracking data for a specific path (used when stream stops)
export function clearPathTracking(path: string): void {
  CONNECTION_TRACKER_STATE.delete(path);
}

// Clear all tracking data (used on server shutdown)
export function clearAllTracking(): void {
  CONNECTION_TRACKER_STATE.clear();
}

// Get total active distinct connections count across all paths (alternative export)
export function getTotalActiveDistinctConnectionsCountForPath(path: string): number {
  const state = CONNECTION_TRACKER_STATE.get(path);
  if (!state) return 0;

  const now = Date.now();
  let count = 0;

  for (const [clientId, lastRequestTime] of state.distinctConnections.entries()) {
    if (now - lastRequestTime <= TIMEOUT_WINDOW_MS) {
      count++;
    } else {
      state.distinctConnections.delete(clientId);
    }
  }

  return count;
}
