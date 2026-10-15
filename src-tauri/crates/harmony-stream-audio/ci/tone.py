"""Writes a sine tone: 48 kHz mono s16 WAV at -12 dBFS (amplitude 8000).

  tone.py <hz> <seconds> <out.wav>

A whole number of cycles per second loops without a click.
"""
import math
import struct
import sys
import wave

hz, seconds, out = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
RATE = 48000
AMPLITUDE = 8000
frames = int(RATE * seconds)
data = struct.pack(f"<{frames}h", *(int(AMPLITUDE * math.sin(2 * math.pi * hz * i / RATE)) for i in range(frames)))
with wave.open(out, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(data)
