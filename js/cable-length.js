/**
 * RackStudio - Patch Cord Length Estimator & Device Location Helpers
 */

export const UNIT_HEIGHT_M = 0.04445; // EIA-310 1U height (44.45 mm)
export const RACK_MOUNT_WIDTH_M = 0.45; // 19" usable horizontal port span (450 mm)
export const STANDARD_PATCH_LENGTHS_M = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0];
export const INTER_RACK_DEFAULT_LENGTH_M = 5.0;

/**
 * Finds the rack, installed device, and template for a device ID anywhere in state.
 */
export function findDeviceLocation(state, deviceId) {
  if (!state || !Array.isArray(state.racks) || !deviceId) return null;
  for (const rack of state.racks) {
    const device = rack.installedDevices?.find(d => d.id === deviceId);
    if (device) {
      const template = state.templates?.find(t => t.id === device.templateId) || null;
      return { rack, device, template };
    }
  }
  return null;
}

/**
 * Returns true when cable endpoints reside in different racks.
 */
export function isInterRackCableInState(state, cable) {
  if (!cable?.from?.deviceId || !cable?.to?.deviceId) return false;
  const fromLoc = findDeviceLocation(state, cable.from.deviceId);
  const toLoc = findDeviceLocation(state, cable.to.deviceId);
  return Boolean(fromLoc && toLoc && fromLoc.rack.id !== toLoc.rack.id);
}

/**
 * Rounds raw meters up to the nearest standard factory patch-cord length.
 */
export function roundToStandardPatchLength(rawMeters) {
  const safeMeters = Math.max(0.1, Number(rawMeters) || 0);
  for (const len of STANDARD_PATCH_LENGTHS_M) {
    if (safeMeters <= len + 1e-6) {
      return len;
    }
  }
  return Math.ceil(safeMeters);
}

/**
 * Resolves a human-friendly port label (e.g. 'XG1', 'Port 1', 'WAN 1').
 */
export function getPortDisplayName(template, portId) {
  const port = template?.ports?.find(p => p.id === portId);
  if (!port) return portId || '';
  if (port.type === 'sfp' && /^XG\d+/i.test(port.name || '')) {
    return port.name;
  }
  return port.name || portId;
}

/**
 * Calculates port center coordinates in physical meters relative to rack bottom-left.
 */
function getPortPhysicalMeters(device, template, portId) {
  const uHeight = template?.uHeight || 1;
  const port = template?.ports?.find(p => p.id === portId);
  const xPct = Number.isFinite(port?.x) ? port.x : 50;
  const yPct = Number.isFinite(port?.y) ? port.y : 50;

  const baseBottomM = ((device.uPosition || 1) - 1) * UNIT_HEIGHT_M;
  const portOffsetFromBottomM = ((100 - yPct) / 100) * uHeight * UNIT_HEIGHT_M;

  return {
    xM: (xPct / 100) * RACK_MOUNT_WIDTH_M,
    yM: baseBottomM + portOffsetFromBottomM,
    xPct
  };
}

/**
 * Estimates recommended standard patch-cord length for a cable using rack geometry
 * and active routing mode ('channels' vs 'arcs').
 */
export function calculateCableLengthEstimate(state, cable, routingMode = null) {
  const fallback = {
    lengthM: Number(cable?.lengthM) || 0.5,
    rawMeters: Number(cable?.lengthM) || 0.5,
    isInterRack: false
  };
  if (!state || !cable?.from || !cable?.to) return fallback;

  const fromLoc = findDeviceLocation(state, cable.from.deviceId);
  const toLoc = findDeviceLocation(state, cable.to.deviceId);
  if (!fromLoc || !toLoc) return fallback;

  if (fromLoc.rack.id !== toLoc.rack.id) {
    return {
      lengthM: Number(cable.lengthM) || INTER_RACK_DEFAULT_LENGTH_M,
      rawMeters: Number(cable.lengthM) || INTER_RACK_DEFAULT_LENGTH_M,
      isInterRack: true
    };
  }

  const p1 = getPortPhysicalMeters(fromLoc.device, fromLoc.template, cable.from.portId);
  const p2 = getPortPhysicalMeters(toLoc.device, toLoc.template, cable.to.portId);

  const mode = routingMode || state.cableRoutingMode || 'channels';
  const dyM = Math.abs(p1.yM - p2.yM);
  const dxM = Math.abs(p1.xM - p2.xM);

  // Matches CableRenderer's ~85px (~1.5U) threshold before routing through side cable channels
  const usesSideChannel = mode === 'channels' && dyM > UNIT_HEIGHT_M * 1.5;

  let rawMeters;
  if (usesSideChannel) {
    const avgXPct = (p1.xPct + p2.xPct) / 2;
    const channelEdgeXM = avgXPct < 50 ? 0 : RACK_MOUNT_WIDTH_M;
    const horizToChannelM = Math.abs(p1.xM - channelEdgeXM) + Math.abs(p2.xM - channelEdgeXM);
    const organizerLoopM = 0.24; // Exit to vertical organizer + bend radius + return
    rawMeters = dyM + horizToChannelM + organizerLoopM;
  } else {
    const frontArcSlackM = 0.14;
    rawMeters = dyM + dxM + frontArcSlackM;
  }

  const roundedRaw = Math.round(rawMeters * 100) / 100;
  return {
    lengthM: roundToStandardPatchLength(rawMeters),
    rawMeters: roundedRaw,
    isInterRack: false
  };
}
