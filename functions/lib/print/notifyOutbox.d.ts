export declare const onOrderProductionReady: import("firebase-functions").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions").Change<import("firebase-functions/v2/firestore").DocumentSnapshot> | undefined, {
    orderId: string;
}>>;
export declare const sweepPrintNotifyOutbox: import("firebase-functions/v2/scheduler").ScheduleFunction;
