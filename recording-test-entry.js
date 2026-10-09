import { initRecordingTest } from './microphone-recorder.js';
initRecordingTest({ document, window, navigator, MediaRecorder: window.MediaRecorder, URL });
