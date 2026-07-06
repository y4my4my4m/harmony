// native engine devices vs navigator.mediaDevices (empty in WebKitGTK)

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
  // dynamic import: VoiceSettingsService consumes this module while
  // nativeLiveKit consumes VoiceSettingsService — avoid the static cycle
  const { isNativeMediaSupported, nativeLiveKit } = await import('@/services/nativeLiveKit');

  if (await isNativeMediaSupported()) {
    const list = await nativeLiveKit.listDevices();
    return [
      ...list.inputs.map((d) => device(d.id, 'audioinput', d.label)),
      ...list.outputs.map((d) => device(d.id, 'audiooutput', d.label)),
      ...list.cameras.map((d) => device(d.id, 'videoinput', d.label)),
    ];
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.map((d) =>
    device(d.deviceId, d.kind as EnumeratedDevice['kind'], d.label, d.groupId)
  );
}
