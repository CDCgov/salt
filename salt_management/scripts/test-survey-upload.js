#!/usr/bin/env node

// Test script to simulate a survey upload with database insertion
const fetch = require('node-fetch');

const API_KEY = 'salt_18dcd398-8c91-4e1e-af2c-542a32eeff3d'; // Test Facility API key
const API_URL = 'http://localhost:3000/api/sync/survey/upload';

const testSurveyData = {
    surveyId: `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    subjectId: `SUBJ-${Math.floor(Math.random() * 10000)}`,
    startDatetime: new Date(Date.now() - 15 * 60000).toISOString(), // 15 minutes ago
    completedAt: new Date().toISOString(),
    language: "English",

    deviceInfo: {
        deviceId: "test-device-001",
        appVersion: "1.0",
        androidVersion: "14",
        deviceModel: "Test Device"
    },

    // Recruitment data
    referralCouponCode: Math.random() > 0.5 ? "TEST123" : null,
    issuedCoupons: ["NEW001", "NEW002"],

    // Test results (rapid tests)
    testResults: [
        {
            testId: "hiv",
            testName: "HIV Rapid Test",
            result: Math.random() > 0.7 ? "positive" : "negative",
            recordedAt: new Date().toISOString()
        },
        {
            testId: "hep_b",
            testName: "Hepatitis B Test",
            result: Math.random() > 0.8 ? "positive" : "negative",
            recordedAt: new Date().toISOString()
        }
    ],

    // Survey answers
    answers: [
        {
            questionId: 0,
            questionShortName: "consent",
            answerValue: 0,
            answerType: "multiple_choice",
            optionText: "Yes"
        },
        {
            questionId: 1,
            questionShortName: "age",
            answerValue: String(18 + Math.floor(Math.random() * 50)),
            answerType: "numeric"
        },
        {
            questionId: 2,
            questionShortName: "gender",
            answerValue: Math.floor(Math.random() * 3),
            answerType: "multiple_choice",
            optionText: ["Male", "Female", "Other"][Math.floor(Math.random() * 3)]
        },
        {
            questionId: 3,
            questionShortName: "hiv_tested",
            answerValue: Math.floor(Math.random() * 2),
            answerType: "multiple_choice",
            optionText: ["Yes", "No"][Math.floor(Math.random() * 2)]
        },
        {
            questionId: 4,
            questionShortName: "risk_factors",
            answerValue: "0,2",
            answerType: "multi_select"
        }
    ]
};

async function uploadSurvey() {
    try {
        console.log('Uploading test survey:', testSurveyData.surveyId);
        console.log('Subject ID:', testSurveyData.subjectId);
        console.log('Referral coupon:', testSurveyData.referralCouponCode || 'None');
        console.log('Rapid test results:', testSurveyData.testResults.length);

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify(testSurveyData)
        });

        const result = await response.json();

        if (response.ok) {
            console.log('\n✅ Upload successful!');
            console.log('Response:', JSON.stringify(result, null, 2));
        } else {
            console.error('\n❌ Upload failed:');
            console.error('Status:', response.status);
            console.error('Error:', result);
        }
    } catch (error) {
        console.error('\n❌ Request failed:', error.message);
    }
}

// Run the test
uploadSurvey();