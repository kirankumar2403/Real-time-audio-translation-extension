let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startCapture' && !isRecording) {
        startRecording();
    } else if (message.action === 'stopCapture' && isRecording) {
        stopRecording();
    }
    return true; // Keep the message channel open for async responses
});

// Start recording tab audio
function startRecording() {
    // First make sure any previous recording is stopped
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    
    audioChunks = [];
    
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (!tabs || !tabs[0]) {
            chrome.runtime.sendMessage({
                action: 'error',
                error: 'No active tab found'
            });
            return;
        }
        
        var tab = tabs[0];
        
        // Use tabCapture API to capture tab audio
        chrome.tabCapture.capture({
            audio: true,
            video: false,
            audioConstraints: {
                mandatory: {
                    chromeMediaSource: 'tab'
                }
            }
        }, function(stream) {
            if (chrome.runtime.lastError) {
                chrome.runtime.sendMessage({
                    action: 'error',
                    error: 'Tab capture error: ' + chrome.runtime.lastError.message
                });
                return;
            }
            
            if (!stream) {
                chrome.runtime.sendMessage({
                    action: 'error',
                    error: 'Failed to capture tab audio. Make sure audio is playing in the tab.'
                });
                return;
            }
            
            // Create a MediaRecorder to record the stream
            mediaRecorder = new MediaRecorder(stream);
            
            // Collect audio data and send for real-time transcription
            mediaRecorder.ondataavailable = function(event) {
                if (event.data.size > 0) {
                    audioChunks.push(event.data);
                    
                    // Send this chunk for real-time transcription
                    sendAudioChunkForTranscription(event.data).catch(function(error) {
                        console.error('Error sending audio chunk:', error);
                    });
                }
            };
            
            // Handle recording completion
            mediaRecorder.onstop = function() {
                isRecording = false;
                
                // Release the stream
                if (stream) {
                    stream.getTracks().forEach(function(track) {
                        track.stop();
                    });
                }
                
                if (audioChunks.length === 0) {
                    chrome.runtime.sendMessage({
                        action: 'error',
                        error: 'No audio data was captured. Make sure audio is playing in the tab.'
                    });
                    return;
                }
                
                // Create a Blob from the audio chunks
                var audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                
                // Process the recording
                processRecording(audioBlob).catch(function(error) {
                    console.error('Processing error:', error);
                    chrome.runtime.sendMessage({
                        action: 'error',
                        error: error.message
                    });
                });
            };
            
            // Start recording with 1-second chunks
            mediaRecorder.start(1000);
            isRecording = true;
            
            // Notify popup that recording has started
            chrome.runtime.sendMessage({
                action: 'recordingStarted'
            });
        });
    });
}

// Stop the recording
function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    } else {
        isRecording = false;
        chrome.runtime.sendMessage({
            action: 'error',
            error: 'No active recording to stop'
        });
    }
}

// Send a single audio chunk for real-time transcription
function sendAudioChunkForTranscription(audioChunk) {
    return new Promise(function(resolve, reject) {
        try {
            // Create a blob from the audio chunk
            var audioBlob = new Blob([audioChunk], { type: 'audio/webm' });
            
            // Create form data for the API request
            var formData = new FormData();
            formData.append('file', audioBlob, 'audio-chunk.webm');
            formData.append('real_time', 'true');  // Tell the backend this is a real-time chunk
            
            // Send to backend for real-time transcription
            var xhr = new XMLHttpRequest();
            xhr.open('POST', 'http://localhost:5000/transcribe_chunk', true);
            
            xhr.onload = function() {
                if (xhr.status >= 200 && xhr.status < 300) {
                    var result = JSON.parse(xhr.responseText);
                    
                    // Only update the UI if we have actual text
                    if (result && result.text && result.text.trim() !== '') {
                        // Send partial transcription result back to popup
                        chrome.runtime.sendMessage({
                            action: 'partialTranscription',
                            result: result
                        });
                    }
                    resolve();
                } else {
                    reject(new Error('Server responded with ' + xhr.status));
                }
            };
            
            xhr.onerror = function() {
                reject(new Error('Network error'));
            };
            
            xhr.send(formData);
        } catch (error) {
            console.error('Real-time transcription error:', error);
            reject(error);
        }
    });
}

// Process the completed recording for final transcription
function processRecording(audioBlob) {
    return new Promise(function(resolve, reject) {
        // Create form data for the API request
        var formData = new FormData();
        formData.append('file', audioBlob, 'audio.webm');
        formData.append('real_time', 'false');  // Tell the backend this is the final audio
        
        // Notify popup that we're processing
        chrome.runtime.sendMessage({
            action: 'processingAudio',
            message: 'Processing complete audio...'
        });
        
        // Send to backend for transcription
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'http://localhost:5000/transcribe', true);
        
        xhr.onload = function() {
            if (xhr.status >= 200 && xhr.status < 300) {
                var result = JSON.parse(xhr.responseText);
                
                // Send final transcription result back to popup
                chrome.runtime.sendMessage({
                    action: 'transcriptionComplete',
                    result: result
                });
                resolve();
            } else {
                var error = new Error('Server responded with ' + xhr.status);
                chrome.runtime.sendMessage({
                    action: 'error',
                    error: error.message
                });
                reject(error);
            }
        };
        
        xhr.onerror = function() {
            var error = new Error('Network error');
            chrome.runtime.sendMessage({
                action: 'error',
                error: error.message
            });
            reject(error);
        };
        
        xhr.send(formData);
    });
}
