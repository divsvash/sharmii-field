import * as Crypto from 'expo-crypto';
import React, { useCallback, useEffect, useState } from 'react';
import { Button, FlatList, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';

import { HttpSyncTransport } from '../data/api/HttpSyncTransport';
import { SqliteAtomicOutboxWriter } from '../data/db/SqliteAtomicOutboxWriter';
import { SqliteOutboxDispatchStore } from '../data/db/SqliteOutboxDispatchStore';
import { SqliteOutboxRepository } from '../data/db/SqliteOutboxRepository';
import { openDatabase } from '../data/db/openDatabase';
import type { SqlDatabase } from '../data/db/SqlDatabase';
import { createPunchIn } from '../domain/attendance/Punch';
import { asIdempotencyKey, type NewOutboxItem, type OutboxItem } from '../domain/sync/OutboxItem';
import { SyncEngine, type SyncEngineRunSummary } from '../domain/sync/SyncEngine';
import { createSyncTrigger } from '../domain/sync/SyncTrigger';

/**
 * The smallest useful demonstration of the offline-first architecture:
 * create a punch, create an incident (as an outbox item — no incident
 * screen fields beyond what's needed to prove the pattern), see both as
 * local outbox rows with their current sync state, and manually trigger
 * a sync pass. No design system, no navigation (this is the only
 * screen), no authentication.
 *
 * GPS coordinates and the selfie path are hardcoded placeholders — camera
 * and location integration are out of scope for this demo; the point is
 * to demonstrate durable local writes and the sync pipeline, not device
 * sensor integration.
 */
export function DemoScreen(): React.ReactElement {
  const [db, setDb] = useState<SqlDatabase | null>(null);
  const [outboxItems, setOutboxItems] = useState<readonly OutboxItem[]>([]);
  const [apiBaseUrl, setApiBaseUrl] = useState('http://localhost:3000');
  const [lastSyncSummary, setLastSyncSummary] = useState<SyncEngineRunSummary | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    openDatabase().then((opened) => {
      if (!cancelled) setDb(opened);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshOutboxItems = useCallback(async (database: SqlDatabase) => {
    const outboxRepo = new SqliteOutboxRepository(database);
    const items = await outboxRepo.listAll();
    setOutboxItems(items);
  }, []);

  useEffect(() => {
    if (db) {
      void refreshOutboxItems(db);
    }
  }, [db, refreshOutboxItems]);

  const handleCreatePunch = useCallback(async () => {
    if (!db) return;
    setBusy(true);
    try {
      const writer = new SqliteAtomicOutboxWriter(db);
      const punchId = Crypto.randomUUID();
      const outboxId = Crypto.randomUUID();
      const idempotencyKey = asIdempotencyKey(Crypto.randomUUID());
      const now = new Date().toISOString();

      const punch = createPunchIn({
        id: punchId,
        employeeId: 'demo-employee',
        siteId: 'demo-site',
        clientTimestamp: now,
        latitude: 28.6139,
        longitude: 77.209,
        gpsAccuracyMeters: 8,
        isMockLocation: false,
        selfiePath: 'file:///demo/selfie-placeholder.jpg',
        idempotencyKey,
        createdAt: now,
      });

      const outboxItem: NewOutboxItem = {
        id: outboxId,
        operation: 'PUNCH_IN',
        entityId: punchId,
        idempotencyKey,
        dependsOnOutboxId: null,
        payload: { punchId, employeeId: punch.employeeId, siteId: punch.siteId, clientTimestamp: now },
        createdAt: now,
      };

      // Durable before the UI treats it as queued: this resolves only
      // after the entity row and the outbox row commit together.
      await writer.recordPunch(punch, outboxItem);
      await refreshOutboxItems(db);
    } finally {
      setBusy(false);
    }
  }, [db, refreshOutboxItems]);

  const handleCreateIncident = useCallback(async () => {
    if (!db) return;
    setBusy(true);
    try {
      const writer = new SqliteAtomicOutboxWriter(db);
      const incidentId = Crypto.randomUUID();
      const outboxId = Crypto.randomUUID();
      const idempotencyKey = asIdempotencyKey(Crypto.randomUUID());
      const now = new Date().toISOString();

      const incident = {
        id: incidentId,
        employeeId: 'demo-employee',
        category: 'SAFETY',
        description: 'Demo incident created from the offline-first demo screen',
        severity: 'LOW' as const,
        clientTimestamp: now,
        idempotencyKey,
        createdAt: now,
      };

      const outboxItem: NewOutboxItem = {
        id: outboxId,
        operation: 'INCIDENT_CREATE',
        entityId: incidentId,
        idempotencyKey,
        dependsOnOutboxId: null,
        payload: {
          incidentId,
          category: incident.category,
          description: incident.description,
          severity: incident.severity,
        },
        createdAt: now,
      };

      await writer.recordIncident(incident, outboxItem);
      await refreshOutboxItems(db);
    } finally {
      setBusy(false);
    }
  }, [db, refreshOutboxItems]);

  const handleSyncNow = useCallback(async () => {
    if (!db) return;
    setBusy(true);
    try {
      const outboxRepo = new SqliteOutboxRepository(db);
      const dispatchStore = new SqliteOutboxDispatchStore(db);
      const transport = new HttpSyncTransport({ baseUrl: apiBaseUrl });
      const engine = new SyncEngine(outboxRepo, dispatchStore, transport);
      const trigger = createSyncTrigger(engine);

      const summary = await trigger.syncNow();
      setLastSyncSummary(summary);
      await refreshOutboxItems(db);
    } finally {
      setBusy(false);
    }
  }, [db, apiBaseUrl, refreshOutboxItems]);

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.heading}>Shramii Field — Offline-First Demo</Text>

      <View style={styles.row}>
        <Button title="Create Punch" onPress={handleCreatePunch} disabled={!db || busy} />
        <Button title="Create Incident" onPress={handleCreateIncident} disabled={!db || busy} />
      </View>

      <Text style={styles.label}>Sync API base URL (no server running = expect retryable failures):</Text>
      <TextInput
        style={styles.input}
        value={apiBaseUrl}
        onChangeText={setApiBaseUrl}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Button title="Sync Now" onPress={handleSyncNow} disabled={!db || busy} />

      {lastSyncSummary && (
        <Text style={styles.summary}>
          Last sync — attempted: {lastSyncSummary.attempted}, succeeded: {lastSyncSummary.succeeded}, retryable:{' '}
          {lastSyncSummary.retryableFailures}, terminal: {lastSyncSummary.terminalFailures}, blocked:{' '}
          {lastSyncSummary.blocked}
        </Text>
      )}

      <Text style={styles.label}>Local outbox items:</Text>
      <FlatList
        data={outboxItems}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.itemRow}>
            <Text style={styles.itemText}>
              {item.operation} · {item.entityId} · {item.status}
              {item.status === 'FAILED_RETRYABLE' && item.nextAttemptAt
                ? ` (next attempt ${item.nextAttemptAt})`
                : ''}
            </Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.itemText}>No local records yet.</Text>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  heading: { fontSize: 18, fontWeight: '600', marginBottom: 12 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  label: { marginTop: 12, marginBottom: 4, fontSize: 13, color: '#444' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 4, padding: 8, marginBottom: 8 },
  summary: { marginTop: 8, marginBottom: 8, fontSize: 13 },
  itemRow: { paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ddd' },
  itemText: { fontSize: 13 },
});
