package com.dev.salt

import android.content.Context
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Tablets upgraded from a build that used android-database-sqlcipher 4.5.4
 * must still open their encrypted database with sqlcipher-android.
 *
 * Fixture: assets/sqlcipher_4_5_4_fixture.db, written by the old library's
 * SupportFactory (the app's own code path) in WAL mode, with the raw 32-byte
 * passphrase below (it includes a zero byte and bytes >= 0x80, like the
 * random key from DatabaseKeyManager). Table answers(id, short_name,
 * other_text) holding gender/'non-binary é ✓', drugs/NULL, age/NULL.
 */
@RunWith(AndroidJUnit4::class)
class LegacySqlcipherDatabaseTest {
    private val name = "legacy_fixture_test.db"
    private val passphrase = ByteArray(32) { i -> (i * 37 + 0x80).toByte() }.also { it[5] = 0 }
    private lateinit var context: Context

    @Before
    fun setUp() {
        System.loadLibrary("sqlcipher")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        context = instrumentation.targetContext
        context.deleteDatabase(name)
        val target = context.getDatabasePath(name).apply { parentFile?.mkdirs() }
        instrumentation.context.assets.open("sqlcipher_4_5_4_fixture.db").use { input ->
            target.outputStream().use { input.copyTo(it) }
        }
    }

    private fun open(key: ByteArray): SupportSQLiteOpenHelper {
        val config = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(name)
            .callback(object : SupportSQLiteOpenHelper.Callback(1) {
                override fun onCreate(db: SupportSQLiteDatabase) {}
                override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) {}
            })
            .build()
        return SupportOpenHelperFactory(key.clone()).create(config).apply { setWriteAheadLoggingEnabled(true) }
    }

    private fun SupportSQLiteDatabase.string(sql: String): String? =
        query(sql).use { it.moveToFirst(); if (it.isNull(0)) null else it.getString(0) }

    @Test
    fun opensDatabaseWrittenByOldLibrary() {
        val helper = open(passphrase)
        val db = helper.writableDatabase
        assertEquals("ok", db.string("PRAGMA cipher_integrity_check") ?: "ok")
        assertEquals("3", db.string("SELECT COUNT(*) FROM answers"))
        assertEquals("non-binary é ✓", db.string("SELECT other_text FROM answers WHERE short_name = 'gender'"))
        assertTrue(db.string("PRAGMA cipher_version")!!.startsWith("4.20"))

        db.execSQL("INSERT INTO answers (short_name, other_text) VALUES ('new', 'after upgrade')")
        helper.close()

        val again = open(passphrase)
        assertEquals("after upgrade", again.readableDatabase.string("SELECT other_text FROM answers WHERE short_name = 'new'"))
        again.close()
    }

    @Test
    fun wrongKeyIsRejected() {
        val wrong = passphrase.clone().also { it[0] = (it[0] + 1).toByte() }
        val helper = open(wrong)
        try {
            helper.readableDatabase.string("SELECT COUNT(*) FROM answers")
            fail("opened the database with the wrong key")
        } catch (e: Exception) {
            // expected: "file is not a database"
        } finally {
            helper.close()
        }
    }
}
