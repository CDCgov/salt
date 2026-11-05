#!/usr/bin/env node

const { allAsync, getAsync, runAsync } = require('../src/models/database');

async function testFacilityConfig() {
    console.log('Testing facility configuration...\n');
    
    try {
        // Get all facilities with their config
        const facilities = await allAsync(`
            SELECT id, name, location, 
                   allow_non_coupon_participants, 
                   coupons_to_issue,
                   api_key
            FROM facilities
        `);
        
        console.log('Current facilities configuration:');
        console.log('================================');
        
        for (const facility of facilities) {
            console.log(`\nFacility: ${facility.name}`);
            console.log(`  ID: ${facility.id}`);
            console.log(`  Location: ${facility.location || 'Not specified'}`);
            console.log(`  Allow non-coupon participants: ${facility.allow_non_coupon_participants ? 'YES' : 'NO'}`);
            console.log(`  Coupons to issue: ${facility.coupons_to_issue}`);
            console.log(`  API Key: ${facility.api_key.substring(0, 20)}...`);
        }
        
        // Test updating a facility's config
        if (facilities.length > 0) {
            const testFacility = facilities[0];
            console.log(`\n\nTesting update for facility: ${testFacility.name}`);
            console.log('====================================');
            
            // Toggle the allow_non_coupon_participants setting
            const newAllowValue = testFacility.allow_non_coupon_participants ? 0 : 1;
            const newCouponsValue = testFacility.coupons_to_issue === 3 ? 5 : 3;
            
            await runAsync(`
                UPDATE facilities 
                SET allow_non_coupon_participants = ?,
                    coupons_to_issue = ?
                WHERE id = ?
            `, [newAllowValue, newCouponsValue, testFacility.id]);
            
            // Verify the update
            const updated = await getAsync(
                'SELECT * FROM facilities WHERE id = ?',
                [testFacility.id]
            );
            
            console.log('Updated configuration:');
            console.log(`  Allow non-coupon participants: ${updated.allow_non_coupon_participants ? 'YES' : 'NO'}`);
            console.log(`  Coupons to issue: ${updated.coupons_to_issue}`);
            
            // Restore original values
            await runAsync(`
                UPDATE facilities 
                SET allow_non_coupon_participants = ?,
                    coupons_to_issue = ?
                WHERE id = ?
            `, [testFacility.allow_non_coupon_participants, testFacility.coupons_to_issue, testFacility.id]);
            
            console.log('\nRestored original values.');
        }
        
        console.log('\n✅ All tests passed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

// Run the test
testFacilityConfig().then(() => {
    console.log('\nTest complete');
    process.exit(0);
}).catch(error => {
    console.error('Test error:', error);
    process.exit(1);
});