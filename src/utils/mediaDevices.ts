// navigator.mediaDevices.enumerateDevices() as plain, serialisable objects

export interface EnumeratedDevice {
  deviceId: string;
  kind: 'audioinput' | 'audiooutput' | 'videoinput';
  label: string;
  groupId: string;
  // satisfies the MediaDeviceInfo interface component refs are typed with
  toJSON: () => unknown;
}

function device(
  deviceId: string,
  kind: EnumeratedDevice['kind'],
  label: string,
  groupId = ''
): EnumeratedDevice {
  const d = { deviceId, kind, label, groupId, toJSON: () => d };
  return d;
}

export async function enumerateMediaDevices(): Promise<EnumeratedDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.map((d) =>
    device(d.deviceId, d.kind as EnumeratedDevice['kind'], d.label, d.groupId)
  );
}
