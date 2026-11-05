const http = require('http');

// Test survey data
const surveyData = {
    survey: {
        id: "test-survey-001",
        subject_id: "participant-001",
        start_datetime: Date.now(),
        language: "en"
    },
    answers: [
        {
            id: "answer-1",
            survey_id: "test-survey-001",
            question_id: 1,
            option_question_index: 0,
            answer_language: "en",
            answer_primary_language_text: "Yes"
        },
        {
            id: "answer-2",
            survey_id: "test-survey-001",
            question_id: 2,
            option_question_index: 1,
            answer_language: "en",
            answer_primary_language_text: "No"
        }
    ],
    device: {
        model: "Test Device",
        manufacturer: "Test",
        android_version: "14",
        app_version: "1.0.0"
    }
};

const postData = JSON.stringify(surveyData);

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/sync/survey/upload',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'X-API-Key': 'fac_b83d45ae08113b380154e6134fa733a7fa945097983a24adee35d1350818ddbd'
    }
};

console.log('Testing survey upload endpoint...');
console.log('URL:', `http://${options.hostname}:${options.port}${options.path}`);

const req = http.request(options, (res) => {
    console.log(`Status Code: ${res.statusCode}`);
    console.log('Headers:', res.headers);

    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        try {
            const response = JSON.parse(data);
            console.log('Response:', JSON.stringify(response, null, 2));
            
            if (response.status === 'success') {
                console.log('\n✅ Upload test successful!');
            } else {
                console.log('\n❌ Upload test failed');
            }
        } catch (e) {
            console.error('Failed to parse response:', data);
        }
    });
});

req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
});

// Write data to request body
req.write(postData);
req.end();