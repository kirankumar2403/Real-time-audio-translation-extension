document.addEventListener('DOMContentLoaded', function() {
    const startButton = document.getElementById('startCapture');
    const stopButton = document.getElementById('stopCapture');
    const statusElement = document.getElementById('status');
    const transcriptionElement = document.getElementById('transcription');
    
    // Add save button if it doesn't exist
    let saveButton = document.getElementById('saveTranscription');
    if (!saveButton) {
        saveButton = document.createElement('button');
        saveButton.id = 'saveTranscription';
        saveButton.className = 'btn';
        saveButton.textContent = 'Save Transcription';
        saveButton.disabled = true;
        document.querySelector('.controls').appendChild(saveButton);
    }
    
    // Add timer element if it doesn't exist
    let timerElement = document.getElementById('timer');
    if (!timerElement) {
        timerElement = document.createElement('div');
        timerElement.id = 'timer';
        timerElement.className = 'timer';
        timerElement.textContent = '00:00';
        document.querySelector('.status').insertAdjacentElement('afterend', timerElement);
    }
    
    let audioContext, recorder, gumStream;
    let isRecording = false;
    let sessionActive = false;
    
    // Set initial status
    statusElement.textContent = 'Ready to capture tab audio';
    statusElement.style.color = '#4caf50';
    
    startButton.addEventListener('click', () => {
        if (isRecording) return;
        chrome.tabCapture.capture({ audio: true, video: false }, function(stream) {
            if (!stream) {
                statusElement.textContent = 'Could not capture tab audio. Make sure audio is playing in the tab and you have permission.';
                statusElement.style.color = '#f44336';
                return;
            }
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            gumStream = stream;
            let input = audioContext.createMediaStreamSource(stream);
            recorder = new Recorder(input, { numChannels: 1 });
            recorder.record();
            isRecording = true;
            sessionActive = true;
            statusElement.textContent = 'Capturing tab audio...';
            transcriptionElement.textContent = 'Listening...';

            // Send chunks every second
            sendChunks();
        });
        startButton.disabled = true;
        stopButton.disabled = false;
    });
    
    function startRecording() {
        chrome.runtime.sendMessage({ action: 'startCapture' });
        startButton.disabled = true;
        stopButton.disabled = false;
        statusElement.textContent = 'Capturing tab audio...';
        statusElement.style.color = '#f44336';
        transcriptionElement.textContent = 'Listening...';
        isRecording = true;
        
        // Start the timer
        recordingStartTime = Date.now();
        updateTimer();
        timerInterval = setInterval(updateTimer, 1000);
        timerElement.style.display = 'block';
    }
    
    // Update the timer display
    function updateTimer() {
        const elapsedTime = Math.floor((Date.now() - recordingStartTime) / 1000);
        const minutes = Math.floor(elapsedTime / 60).toString().padStart(2, '0');
        const seconds = (elapsedTime % 60).toString().padStart(2, '0');
        timerElement.textContent = `${minutes}:${seconds}`;
    }
    
    function sendChunks() {
        if (!isRecording || !sessionActive) return;
        recorder.exportWAV(function(blob) {
            if (blob.size > 2000 && sessionActive) { // increased threshold
                const formData = new FormData();
                formData.append('file', blob, 'chunk.wav');
                fetch('http://localhost:8000/transcribe_chunk', {
                    method: 'POST',
                    body: formData
                })
                .then(response => response.json())
                .then(data => {
                    if (data.partial) {
                        transcriptionElement.textContent = data.partial;
                        console.log('Partial:', data.partial);
                    }
                })
                .catch(err => {
                    if (isRecording && sessionActive) {
                        console.error('Chunk transcription error:', err);
                    }
                });
            }
            recorder.clear();
            if (isRecording && sessionActive) {
                setTimeout(sendChunks, 2000); // send every 2 seconds
            }
        });
    }
    
    stopButton.addEventListener('click', () => {
        if (!isRecording) return;
        sessionActive = false;
        isRecording = false;
        recorder.stop();
        gumStream.getAudioTracks()[0].stop();
        startButton.disabled = false;
        stopButton.disabled = true;
        statusElement.textContent = 'Processing...';
        statusElement.style.color = '#ff9800';
        // Optionally, call /reset_session to clear backend recognizer
        fetch('http://localhost:8000/reset_session', { method: 'POST' });
    });
    
    // Add save transcription functionality
    saveButton.addEventListener('click', () => {
        const text = transcriptionElement.textContent;
        if (text && text !== 'No transcription yet' && text !== 'Listening...') {
            // Create a blob and download link
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'transcription-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.txt';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    });
    
    // Listen for messages from background script
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'transcriptionComplete') {
            statusElement.textContent = 'Ready to record';
            statusElement.style.color = '#4caf50';
            
            if (message.result && message.result.text) {
                transcriptionElement.textContent = message.result.text;
                // Enable save button when transcription is complete
                saveButton.disabled = false;
                // Log the complete transcription to the console
                console.log('Transcription Complete:', message.result.text);
            } else {
                transcriptionElement.textContent = 'No transcription available or error occurred';
            }
            
            // Reset timer display
            timerElement.textContent = '00:00';
        } else if (message.action === 'partialTranscription') {
            // Update with real-time transcription
            if (message.result && message.result.text) {
                // Append new text or replace existing text based on your preference
                if (transcriptionElement.textContent === 'No transcription yet' || 
                    transcriptionElement.textContent === 'Listening...') {
                    transcriptionElement.textContent = message.result.text;
                } else {
                    // Option 1: Replace the text completely
                    transcriptionElement.textContent = message.result.text;
                    
                    // Option 2: Append the text (uncomment if you prefer this)
                    // transcriptionElement.textContent += ' ' + message.result.text;
                }
                // Log the partial transcription to the console
                console.log('Partial Transcription:', message.result.text);
            }
        } else if (message.action === 'processingAudio') {
            statusElement.textContent = message.message || 'Processing...';
            statusElement.style.color = '#ff9800';
        } else if (message.action === 'recordingStarted') {
            statusElement.textContent = 'Recording...';
            statusElement.style.color = '#f44336';
            // Clear previous transcription when starting a new recording
            transcriptionElement.textContent = 'Listening...';
            // Disable save button when starting a new recording
            saveButton.disabled = true;
        } else if (message.action === 'error') {
            statusElement.textContent = 'Error: ' + message.error;
            statusElement.style.color = '#f44336';
            startButton.disabled = false;
            stopButton.disabled = true;
            isRecording = false;
            // Stop the timer if there's an error
            clearInterval(timerInterval);
        }
    });
});
