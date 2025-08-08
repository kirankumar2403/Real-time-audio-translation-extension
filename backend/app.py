from flask import Flask, request, jsonify
import vosk
import wave
import json
import tempfile
import os
from flask_cors import CORS
import io
import soundfile as sf
import numpy as np
import subprocess
from googletrans import Translator

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Initialize the Vosk model
model = vosk.Model("d:\\vosk-model-small-en-us-0.15\\vosk-model-small-en-us-0.15")

# Store recognizers for real-time transcription sessions
recognizers = {}

translator = Translator()

@app.route("/transcribe", methods=["POST"])
def transcribe():
    """Process a complete audio file for transcription"""
    # Accept both 'audio' and 'file' as possible field names
    audio_file = request.files.get('audio') or request.files.get('file')
    if not audio_file:
        return jsonify({"error": "No file part"}), 400
    if audio_file.filename == '':
        return jsonify({"error": "No selected file"}), 400
    print(f"Received file: {audio_file.filename}")
    # Save the uploaded file to a temporary location
    temp_webm = tempfile.NamedTemporaryFile(delete=False, suffix='.webm')
    audio_file.save(temp_webm.name)
    temp_webm.close()
    temp_wav = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
    temp_wav.close()
    try:
        # Convert webm to wav using ffmpeg
        ffmpeg_cmd = [
            'ffmpeg', '-y', '-i', temp_webm.name,
            '-ar', '16000', '-ac', '1', '-f', 'wav', temp_wav.name
        ]
        result = subprocess.run(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode != 0:
            print("ffmpeg stderr:", result.stderr.decode())
            return jsonify({"error": "ffmpeg failed: " + result.stderr.decode()}), 500
        # Now read the wav file with soundfile
        data, samplerate = sf.read(temp_wav.name)
        if len(data.shape) > 1:
            data = np.mean(data, axis=1)
        audio_data = (data * 32767).astype(np.int16)
        recognizer = vosk.KaldiRecognizer(model, samplerate)
        recognizer.AcceptWaveform(audio_data.tobytes())
        result = json.loads(recognizer.FinalResult())
        transcribed_text = result.get("text", "")
        translated = translator.translate(transcribed_text, dest='hi')  # Hindi
        return jsonify({"text": translated.text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(temp_webm.name)
        os.unlink(temp_wav.name)

@app.route("/transcribe_chunk", methods=["POST"])
def transcribe_chunk():
    audio_file = request.files.get('audio') or request.files.get('file')
    if not audio_file:
        return jsonify({"error": "No file part"}), 400
    if audio_file.filename == '':
        return jsonify({"error": "No audio chunk"}), 400
    session_id = request.remote_addr
    # Save to a temporary webm file
    temp_webm = tempfile.NamedTemporaryFile(delete=False, suffix='.webm')
    audio_file.save(temp_webm.name)
    temp_webm.close()
    temp_wav = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
    temp_wav.close()
    try:
        # Convert webm to wav using ffmpeg
        ffmpeg_cmd = [
            'ffmpeg', '-y', '-i', temp_webm.name,
            '-ar', '16000', '-ac', '1', '-f', 'wav', temp_wav.name
        ]
        result = subprocess.run(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode != 0:
            print("ffmpeg stderr:", result.stderr.decode())
            return jsonify({"error": "ffmpeg failed: " + result.stderr.decode()}), 500
        # Read the wav file
        data, samplerate = sf.read(temp_wav.name)
        if len(data.shape) > 1:
            data = np.mean(data, axis=1)
        audio_data = (data * 32767).astype(np.int16)
        # Get or create a recognizer for this session
        if session_id not in recognizers:
            recognizers[session_id] = vosk.KaldiRecognizer(model, samplerate)
            print(f"Created new recognizer for session {session_id}")
        recognizer = recognizers[session_id]
        if len(audio_data) > 0:
            recognizer.AcceptWaveform(audio_data.tobytes())
        partial_result = json.loads(recognizer.PartialResult())
        partial_text = partial_result.get("partial", "")
        if partial_text:
            translated = translator.translate(partial_text, dest='hi')
            partial_result["partial"] = translated.text
        return jsonify(partial_result)
    except Exception as e:
        print(f"Error processing chunk: {str(e)}")
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(temp_webm.name)
        os.unlink(temp_wav.name)

def process_audio_chunk(audio_file):
    """Convert audio chunk to the format needed by Vosk"""
    # Save to a temporary file
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.webm')
    audio_file.save(temp_file.name)
    temp_file.close()
    
    try:
        # Read the audio data using soundfile
        data, samplerate = sf.read(temp_file.name)
        
        # Convert to mono if stereo
        if len(data.shape) > 1:
            data = np.mean(data, axis=1)
        
        # Convert to 16-bit PCM
        audio_data = (data * 32767).astype(np.int16)
        
        return audio_data, samplerate
    finally:
        # Clean up
        os.unlink(temp_file.name)

@app.route("/reset_session", methods=["POST"])
def reset_session():
    """Reset a transcription session"""
    session_id = request.remote_addr
    
    if session_id in recognizers:
        del recognizers[session_id]
        return jsonify({"message": "Session reset successfully"})
    
    return jsonify({"message": "No active session found"})

@app.route("/", methods=["GET"])
def index():
    return "Transcription API is running!"

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
