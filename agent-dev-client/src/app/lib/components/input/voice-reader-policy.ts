export function shouldSynthesizeVoiceText(params: {
  text: string;
  previousText: string | undefined;
  speechEnabled: boolean;
  isRecordingAudio: boolean;
  voiceEngine: string;
}): boolean {
  return (
    params.text.length > 0 &&
    params.text !== params.previousText &&
    params.speechEnabled &&
    !params.isRecordingAudio &&
    params.voiceEngine !== 'realtime'
  );
}
