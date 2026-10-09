"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "../../../lib/supabase";

type RemoteUser = { id: string; stream: MediaStream };

type Signal = {
  type: "hello" | "offer" | "answer" | "ice-candidate";
  from: string;
  to?: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

function MeetingRoomContent() {
  const searchParams = useSearchParams();
  const room = searchParams.get("room");

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<any>(null);
  const peersRef = useRef<Record<string, RTCPeerConnection>>({});
  const pendingIceRef = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const startedRef = useRef(false);
  const participantIdRef = useRef(crypto.randomUUID());

  const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [message, setMessage] = useState("Connecting to meeting...");

  const sendSignal = useCallback((signal: Signal) => {
    const channel = channelRef.current;
    if (!channel) return;

    void channel.send({
      type: "broadcast",
      event: "signal",
      payload: signal,
    });
  }, []);

  const removeRemoteUser = useCallback((remoteId: string) => {
    const peer = peersRef.current[remoteId];

    if (peer) peer.close();

    delete peersRef.current[remoteId];
    delete pendingIceRef.current[remoteId];

    setRemoteUsers((users) =>
      users.filter((user) => user.id !== remoteId)
    );
  }, []);

  const createPeerConnection = useCallback(
    (remoteId: string) => {
      const existing = peersRef.current[remoteId];
      if (existing) return existing;

      const peer = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });

      peersRef.current[remoteId] = peer;

      localStreamRef.current?.getTracks().forEach((track) => {
        peer.addTrack(track, localStreamRef.current!);
      });

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal({
            type: "ice-candidate",
            from: participantIdRef.current,
            to: remoteId,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      peer.ontrack = (event) => {
        const stream = event.streams[0];
        if (!stream) return;

        setRemoteUsers((users) => {
          const index = users.findIndex((user) => user.id === remoteId);

          if (index >= 0) {
            return users.map((user) =>
              user.id === remoteId ? { ...user, stream } : user
            );
          }

          return [...users, { id: remoteId, stream }];
        });
      };

      peer.onconnectionstatechange = () => {
        if (
          peer.connectionState === "failed" ||
          peer.connectionState === "closed"
        ) {
          removeRemoteUser(remoteId);
        } else if (peer.connectionState === "connected") {
          setMessage("Connected to meeting.");
        }
      };

      return peer;
    },
    [removeRemoteUser, sendSignal]
  );

  const flushPendingIce = useCallback(
    async (remoteId: string, peer: RTCPeerConnection) => {
      const candidates = pendingIceRef.current[remoteId] || [];
      delete pendingIceRef.current[remoteId];

      for (const candidate of candidates) {
        try {
          await peer.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
          console.error("Could not add queued ICE candidate", error);
        }
      }
    },
    []
  );

  const handleSignal = useCallback(
    async (signal: Signal) => {
      const myId = participantIdRef.current;

      if (
        !signal ||
        signal.from === myId ||
        (signal.to && signal.to !== myId)
      ) {
        return;
      }

      try {
        if (signal.type === "hello") {
          // Only one participant initiates each connection.
          if (myId.localeCompare(signal.from) < 0) {
            const peer = createPeerConnection(signal.from);

            if (peer.signalingState === "stable") {
              const offer = await peer.createOffer();
              await peer.setLocalDescription(offer);

              sendSignal({
                type: "offer",
                from: myId,
                to: signal.from,
                offer: peer.localDescription ?? offer,
              });
            }
          }

          return;
        }

        if (signal.type === "offer" && signal.offer) {
          const peer = createPeerConnection(signal.from);

          await peer.setRemoteDescription(
            new RTCSessionDescription(signal.offer)
          );

          await flushPendingIce(signal.from, peer);

          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);

          sendSignal({
            type: "answer",
            from: myId,
            to: signal.from,
            answer: peer.localDescription ?? answer,
          });

          return;
        }

        if (signal.type === "answer" && signal.answer) {
          const peer = peersRef.current[signal.from];
          if (!peer) return;

          await peer.setRemoteDescription(
            new RTCSessionDescription(signal.answer)
          );

          await flushPendingIce(signal.from, peer);
          return;
        }

        if (signal.type === "ice-candidate" && signal.candidate) {
          const peer = peersRef.current[signal.from];

          if (!peer || !peer.remoteDescription) {
            (pendingIceRef.current[signal.from] ||= []).push(
              signal.candidate
            );
            return;
          }

          await peer.addIceCandidate(
            new RTCIceCandidate(signal.candidate)
          );
        }
      } catch (error) {
        console.error("Meeting signaling error:", error);
        setMessage(
          "Could not connect participants. Refresh and try again."
        );
      }
    },
    [createPeerConnection, flushPendingIce, sendSignal]
  );

  useEffect(() => {
    if (!room || startedRef.current) {
      if (!room) setMessage("Meeting room not found.");
      return;
    }

    startedRef.current = true;
    let cancelled = false;

    async function startMeeting() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setMessage(
            "Camera and microphone require HTTPS and a supported browser."
          );
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        localStreamRef.current = stream;

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        const channel = supabase.channel(`meeting-${room}`, {
          config: {
            broadcast: { self: false },
            presence: { key: participantIdRef.current },
          },
        });

        channelRef.current = channel;

        channel.on(
          "broadcast",
          { event: "signal" },
          ({ payload }: { payload: Signal }) => {
            void handleSignal(payload);
          }
        );

        channel.on("presence", { event: "sync" }, () => {
          const state =
            channel.presenceState<Record<string, unknown>>();

          Object.keys(state).forEach((id) => {
            if (id !== participantIdRef.current) {
              sendSignal({
                type: "hello",
                from: participantIdRef.current,
                to: id,
              });
            }
          });
        });

        channel.subscribe(async (status: string) => {
          if (status === "SUBSCRIBED") {
            await channel.track({
              joined_at: new Date().toISOString(),
            });

            setMessage(
              "Connected to room. Waiting for participants..."
            );

            // Retry discovery in case another participant is joining.
            sendSignal({
              type: "hello",
              from: participantIdRef.current,
            });

            window.setTimeout(() => {
              sendSignal({
                type: "hello",
                from: participantIdRef.current,
              });
            }, 1000);

            window.setTimeout(() => {
              sendSignal({
                type: "hello",
                from: participantIdRef.current,
              });
            }, 2500);
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT"
          ) {
            setMessage(
              "Could not connect to meeting signaling. Check Supabase Realtime settings."
            );
          }
        });
      } catch (error) {
        console.error(error);
        setMessage(
          "Camera/microphone access failed. Allow permissions and refresh the page."
        );
      }
    }

    void startMeeting();

    return () => {
      cancelled = true;
      startedRef.current = false;

      Object.values(peersRef.current).forEach((peer) => peer.close());

      peersRef.current = {};
      pendingIceRef.current = {};

      localStreamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });

      localStreamRef.current = null;

      if (channelRef.current) {
        void supabase.removeChannel(channelRef.current);
      }

      channelRef.current = null;
    };
  }, [room, handleSignal, sendSignal]);

  function toggleMic() {
    const next = !micOn;

    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = next;
    });

    setMicOn(next);
  }

  function toggleCamera() {
    const next = !cameraOn;

    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = next;
    });

    setCameraOn(next);
  }

  function leaveMeeting() {
    window.location.href = "/meetings";
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <div>
          <h1 className="text-xl font-bold">Skill Swap Campus</h1>
          <p className="text-sm text-slate-400">
            Meeting Room: {room}
          </p>
        </div>

        <button
          onClick={leaveMeeting}
          className="rounded-lg bg-red-600 px-5 py-2 font-semibold hover:bg-red-700"
        >
          Leave Meeting
        </button>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <div className="relative overflow-hidden rounded-2xl bg-black shadow-lg">
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className="h-[300px] w-full object-cover"
            />
            <div className="absolute bottom-3 left-3 rounded-lg bg-black/60 px-3 py-1 text-sm">
              You
            </div>
          </div>

          {remoteUsers.map((user) => (
            <RemoteVideo
              key={user.id}
              stream={user.stream}
              userId={user.id}
            />
          ))}

          {remoteUsers.length === 0 && (
            <div className="flex h-[300px] items-center justify-center rounded-2xl bg-slate-900">
              <div className="text-center">
                <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-indigo-600 text-3xl">
                  👥
                </div>
                <h2 className="mt-4 text-xl font-semibold">
                  Waiting for participants
                </h2>
                <p className="mt-2 text-sm text-slate-400">
                  Ask another student to join this exact room code.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="mt-8 flex justify-center gap-4">
          <button
            onClick={toggleMic}
            className={`rounded-full px-6 py-3 font-semibold ${
              micOn
                ? "bg-slate-700 hover:bg-slate-600"
                : "bg-red-600 hover:bg-red-700"
            }`}
          >
            {micOn ? "🎤 Mic On" : "🔇 Mic Off"}
          </button>

          <button
            onClick={toggleCamera}
            className={`rounded-full px-6 py-3 font-semibold ${
              cameraOn
                ? "bg-slate-700 hover:bg-slate-600"
                : "bg-red-600 hover:bg-red-700"
            }`}
          >
            {cameraOn ? "📹 Camera On" : "📷 Camera Off"}
          </button>
        </div>

        <p className="mt-6 text-center text-sm text-slate-400">
          {message}
        </p>

        <div className="mt-8 rounded-2xl bg-slate-900 p-6">
          <h2 className="text-lg font-bold">Skill Swap Meeting</h2>
          <p className="mt-2 text-sm text-slate-400">
            WebRTC handles live browser audio/video; Supabase Realtime
            handles signaling and presence.
          </p>
          <p className="mt-3 text-sm text-indigo-400">
            Room Code: {room}
          </p>
          <p className="mt-2 text-sm text-green-400">
            Participants connected: {remoteUsers.length + 1}
          </p>
          <p className="mt-3 text-xs text-slate-500">
            If two participants still cannot connect across different
            networks, a TURN server may be required.
          </p>
        </div>
      </div>
    </main>
  );
}

function RemoteVideo({
  stream,
  userId,
}: {
  stream: MediaStream;
  userId: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="relative overflow-hidden rounded-2xl bg-black shadow-lg">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="h-[300px] w-full object-cover"
      />
      <div className="absolute bottom-3 left-3 rounded-lg bg-black/60 px-3 py-1 text-sm">
        Participant {userId.slice(0, 4)}
      </div>
    </div>
  );
}

export default function MeetingRoom() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
          Loading meeting room...
        </main>
      }
    >
      <MeetingRoomContent />
    </Suspense>
  );
}