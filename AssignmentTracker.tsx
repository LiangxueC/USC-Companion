import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

type Priority = 'High' | 'Medium' | 'Low';

type Assignment = {
  id: string;
  title: string;
  course: string;
  dueDate: string; // YYYY-MM-DD
  priority: Priority;
  completed: boolean;
};

type AddModalState = {
  title: string;
  course: string;
  dueDate: string;
  priority: Priority;
};

const STORAGE_KEY = '@usccompanion:assignments:v1';

const USC_CARDINAL = '#990000';
const USC_GOLD = '#FFCC00';

const PRIORITY_COLORS: Record<Priority, string> = {
  High: '#FF3B30',
  Medium: USC_GOLD,
  Low: '#34C759',
};

function pad2(n: number): string {
  return `${n}`.padStart(2, '0');
}

function isValidDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseDateKey(dateKey: string): Date | null {
  if (!isValidDateKey(dateKey)) return null;
  const [y, m, d] = dateKey.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  // Ensure we didn't overflow (e.g. Feb 31)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function todayKey(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const AssignmentTracker: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const [loading, setLoading] = useState(true);
  const [assignments, setAssignments] = useState<Assignment[]>([]);

  const [modalVisible, setModalVisible] = useState(false);
  const [draft, setDraft] = useState<AddModalState>({
    title: '',
    course: '',
    dueDate: todayKey(),
    priority: 'Medium',
  });

  const modalTitleRef = useRef<TextInput | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as Assignment[];
          if (Array.isArray(parsed)) setAssignments(parsed);
        }
      } catch (e) {
        console.warn('Failed to load assignments', e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (loading) return;
    const save = async () => {
      try {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(assignments));
      } catch (e) {
        console.warn('Failed to save assignments', e);
      }
    };
    save();
  }, [assignments, loading]);

  const nowKey = useMemo(() => todayKey(), []);
  const nowDt = useMemo(() => parseDateKey(nowKey), [nowKey]);

  const sortedAssignments = useMemo(() => {
    const dt = nowDt;
    const overdue = (a: Assignment) => {
      if (!dt) return false;
      const dueDt = parseDateKey(a.dueDate);
      if (!dueDt) return false;
      return !a.completed && dueDt.getTime() < dt.getTime();
    };

    const incomplete = assignments.filter((a) => !a.completed);
    const completed = assignments.filter((a) => a.completed);

    const prioRank: Record<Priority, number> = { High: 0, Medium: 1, Low: 2 };

    incomplete.sort((a, b) => {
      // Overdue first, then due date, then priority
      const ao = overdue(a);
      const bo = overdue(b);
      if (ao !== bo) return ao ? -1 : 1;
      const ad = parseDateKey(a.dueDate)?.getTime() ?? 0;
      const bd = parseDateKey(b.dueDate)?.getTime() ?? 0;
      if (ad !== bd) return ad - bd;
      return prioRank[a.priority] - prioRank[b.priority];
    });

    completed.sort((a, b) => {
      const ad = parseDateKey(a.dueDate)?.getTime() ?? 0;
      const bd = parseDateKey(b.dueDate)?.getTime() ?? 0;
      if (ad !== bd) return ad - bd;
      return prioRank[a.priority] - prioRank[b.priority];
    });

    return [...incomplete, ...completed];
  }, [assignments, nowDt]);

  const openAddModal = () => {
    setDraft({
      title: '',
      course: '',
      dueDate: nowKey,
      priority: 'Medium',
    });
    setModalVisible(true);
    setTimeout(() => modalTitleRef.current?.focus(), 50);
  };

  const closeAddModal = () => setModalVisible(false);

  const addAssignment = () => {
    const title = draft.title.trim();
    const course = draft.course.trim();
    const due = draft.dueDate.trim();
    if (!title || !course) return;
    if (!isValidDateKey(due)) return;

    const newAssignment: Assignment = {
      id: makeId(),
      title,
      course,
      dueDate: due,
      priority: draft.priority,
      completed: false,
    };
    setAssignments((prev) => [...prev, newAssignment]);
    setModalVisible(false);
  };

  const toggleCompleted = (id: string) => {
    setAssignments((prev) => prev.map((a) => (a.id === id ? { ...a, completed: !a.completed } : a)));
  };

  const isOverdue = (a: Assignment): boolean => {
    if (a.completed) return false;
    if (!nowDt) return false;
    const dueDt = parseDateKey(a.dueDate);
    if (!dueDt) return false;
    return dueDt.getTime() < nowDt.getTime();
  };

  const renderAssignment = ({ item }: { item: Assignment }) => {
    const borderColor = PRIORITY_COLORS[item.priority];
    const overdue = isOverdue(item);
    const textColor = overdue ? '#FF3B30' : '#ffffff';
    const dueTextColor = overdue ? '#FF3B30' : 'rgba(255,255,255,0.8)';

    return (
      <View
        style={[
          styles.card,
          overdue && { borderColor: 'rgba(255,59,48,0.65)', backgroundColor: '#141010' },
        ]}
      >
        <View style={[styles.leftBar, { backgroundColor: borderColor }]} />
        <View style={styles.cardBody}>
          <TouchableOpacity
            style={styles.checkRow}
            onPress={() => toggleCompleted(item.id)}
            activeOpacity={0.9}
          >
            <View
              style={[
                styles.checkbox,
                item.completed && { backgroundColor: USC_CARDINAL, borderColor: USC_CARDINAL },
              ]}
            >
              {item.completed ? <Text style={styles.checkboxCheck}>✓</Text> : null}
            </View>
            <View style={styles.checkTextWrap}>
              <Text
                style={[
                  styles.title,
                  { color: textColor },
                  item.completed && { textDecorationLine: 'line-through', opacity: 0.65 },
                ]}
                numberOfLines={2}
              >
                {item.title}
              </Text>
              <Text
                style={[
                  styles.meta,
                  item.completed && { opacity: 0.65 },
                  { color: 'rgba(255,255,255,0.75)' },
                ]}
                numberOfLines={1}
              >
                {item.course}
              </Text>
              <Text
                style={[
                  styles.due,
                  item.completed && { opacity: 0.65 },
                  { color: dueTextColor },
                ]}
              >
                Due {item.dueDate}
              </Text>
            </View>
          </TouchableOpacity>

          <View style={styles.priorityPill}>
            <Text style={styles.priorityPillText}>
              {item.priority}
              {overdue ? ' • Overdue' : ''}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => (onBack ? onBack() : undefined)}
          activeOpacity={0.85}
        >
          <Text style={styles.backButtonText}>{'‹'}</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Assignment Tracker</Text>
        </View>
        <View style={styles.headerRight} />
      </View>

      <View style={styles.body}>
        {loading ? (
          <Text style={styles.loadingText}>Loading…</Text>
        ) : sortedAssignments.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No assignments yet</Text>
            <Text style={styles.emptySubtitle}>Tap + to add your first assignment.</Text>
          </View>
        ) : (
          <FlatList
            data={sortedAssignments}
            keyExtractor={(it) => it.id}
            renderItem={renderAssignment}
            contentContainerStyle={styles.listContent}
          />
        )}
      </View>

      <TouchableOpacity style={styles.fab} onPress={openAddModal} activeOpacity={0.9}>
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>

      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={closeAddModal}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add assignment</Text>

            <Text style={styles.modalLabel}>Title</Text>
            <TextInput
              ref={(r) => {
                modalTitleRef.current = r;
              }}
              value={draft.title}
              onChangeText={(t) => setDraft((prev) => ({ ...prev, title: t }))}
              placeholder="e.g. Write lab report"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={styles.modalInput}
              autoCapitalize="sentences"
            />

            <Text style={styles.modalLabel}>Course</Text>
            <TextInput
              value={draft.course}
              onChangeText={(t) => setDraft((prev) => ({ ...prev, course: t }))}
              placeholder="e.g. CSCI 201"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={styles.modalInput}
            />

            <Text style={styles.modalLabel}>Due date (YYYY-MM-DD)</Text>
            <TextInput
              value={draft.dueDate}
              onChangeText={(t) => setDraft((prev) => ({ ...prev, dueDate: t }))}
              placeholder="2026-04-30"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={styles.modalInput}
            />

            <Text style={styles.modalLabel}>Priority</Text>
            <View style={styles.priorityPicker}>
              {(['High', 'Medium', 'Low'] as Priority[]).map((p) => {
                const active = draft.priority === p;
                return (
                  <TouchableOpacity
                    key={p}
                    style={[
                      styles.priorityChip,
                      active && { backgroundColor: USC_CARDINAL, borderColor: USC_CARDINAL },
                    ]}
                    onPress={() => setDraft((prev) => ({ ...prev, priority: p }))}
                    activeOpacity={0.9}
                  >
                    <Text style={[styles.priorityChipText, active && { color: '#fff' }]}>
                      {p}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.modalButtonRow}>
              <TouchableOpacity style={styles.modalSecondaryButton} onPress={closeAddModal}>
                <Text style={styles.modalSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalPrimaryButton} onPress={addAssignment}>
                <Text style={styles.modalPrimaryText}>Save</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.modalHint}>
              Overdue items are highlighted. Completed items appear at the bottom.
            </Text>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

export default AssignmentTracker;
export { AssignmentTracker };

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0b0b',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: USC_CARDINAL,
    paddingHorizontal: 10,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  backButtonText: {
    color: USC_GOLD,
    fontWeight: '900',
    fontSize: 22,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 18,
  },
  headerRight: {
    width: 44,
  },
  body: {
    flex: 1,
  },
  loadingText: {
    color: 'rgba(255,255,255,0.7)',
    padding: 16,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  emptyTitle: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 16,
  },
  emptySubtitle: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingBottom: 120,
  },
  card: {
    flexDirection: 'row',
    borderRadius: 16,
    backgroundColor: '#141414',
    marginVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  leftBar: {
    width: 7,
  },
  cardBody: {
    flex: 1,
    padding: 12,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    marginTop: 2,
  },
  checkboxCheck: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 14,
  },
  checkTextWrap: {
    flex: 1,
  },
  title: {
    fontWeight: '900',
    fontSize: 15,
  },
  meta: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: '800',
  },
  due: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: '800',
  },
  priorityPill: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  priorityPillText: {
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '900',
    fontSize: 12,
  },
  fab: {
    position: 'absolute',
    right: 22,
    bottom: 42,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: USC_GOLD,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  fabText: {
    color: USC_CARDINAL,
    fontSize: 34,
    fontWeight: '900',
    marginTop: -4,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#121212',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 26,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  modalTitle: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 18,
    marginBottom: 10,
  },
  modalLabel: {
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '900',
    fontSize: 13,
    marginTop: 12,
    marginBottom: 6,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: '#0f0f0f',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#ffffff',
    fontSize: 14,
  },
  priorityPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
  },
  priorityChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginRight: 8,
    marginBottom: 10,
  },
  priorityChipText: {
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '900',
    fontSize: 13,
  },
  modalButtonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  modalSecondaryButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    marginRight: 10,
  },
  modalSecondaryText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 14,
  },
  modalPrimaryButton: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: USC_CARDINAL,
    borderWidth: 1,
    borderColor: USC_CARDINAL,
  },
  modalPrimaryText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 14,
  },
  modalHint: {
    marginTop: 10,
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    lineHeight: 18,
  },
});

