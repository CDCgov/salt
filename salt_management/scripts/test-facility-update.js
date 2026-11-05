#!/usr/bin/env node

const { getAsync, runAsync } = require('../src/models/database');

async function testFacilityUpdate() {
    console.log('Testing facility update...\n');
    
    try {
        // Check current values
        console.log('BEFORE update:');
        let facility = await getAsync(
            'SELECT * FROM facilities WHERE id = 2'
        );
        console.log(`  Facility: ${facility.name}`);
        console.log(`  Allow non-coupon: ${facility.allow_non_coupon_participants}`);
        console.log(`  Coupons to issue: ${facility.coupons_to_issue}`);
        
        // Update the facility
        console.log('\nUpdating facility...');
        await runAsync(
            `UPDATE facilities 
             SET allow_non_coupon_participants = ?,
                 coupons_to_issue = ?
             WHERE id = ?`,
            [0, 7, 2]  // Set to false (0) and 7 coupons
        );
        
        // Check after update
        console.log('\nAFTER update:');
        facility = await getAsync(
            'SELECT * FROM facilities WHERE id = 2'
        );
        console.log(`  Facility: ${facility.name}`);
        console.log(`  Allow non-coupon: ${facility.allow_non_coupon_participants}`);
        console.log(`  Coupons to issue: ${facility.coupons_to_issue}`);
        
        // Test the API route logic
        console.log('\n\nTesting API route logic:');
        const testData = {
            allow_non_coupon_participants: false,
            coupons_to_issue: 5
        };
        
        const updates = [];
        const values = [];
        
        if (testData.allow_non_coupon_participants !== undefined) {
            updates.push('allow_non_coupon_participants = ?');
            values.push(testData.allow_non_coupon_participants ? 1 : 0);
            console.log(`  Will set allow_non_coupon_participants to: ${testData.allow_non_coupon_participants ? 1 : 0}`);
        }
        if (testData.coupons_to_issue !== undefined) {
            updates.push('coupons_to_issue = ?');
            values.push(testData.coupons_to_issue);
            console.log(`  Will set coupons_to_issue to: ${testData.coupons_to_issue}`);
        }
        
        if (updates.length > 0) {
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(2); // facility ID
            
            const query = `UPDATE facilities SET ${updates.join(', ')} WHERE id = ?`;
            console.log(`\n  Generated query: ${query}`);
            console.log(`  With values: [${values.join(', ')}]`);
            
            await runAsync(query, values);
            
            // Check final result
            console.log('\nFINAL result:');
            facility = await getAsync(
                'SELECT * FROM facilities WHERE id = 2'
            );
            console.log(`  Facility: ${facility.name}`);
            console.log(`  Allow non-coupon: ${facility.allow_non_coupon_participants}`);
            console.log(`  Coupons to issue: ${facility.coupons_to_issue}`);
        }
        
        console.log('\n✅ Test completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

// Run the test
testFacilityUpdate().then(() => {
    process.exit(0);
}).catch(error => {
    console.error('Test error:', error);
    process.exit(1);
});