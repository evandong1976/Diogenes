import { initializeApp } from 'firebase/app'
import { collection, getDocs, getFirestore } from 'firebase/firestore'

const app = initializeApp({ projectId: 'notes-demo' })
const db = getFirestore(app)

export async function listNotes(): Promise<string[]> {
  const snapshot = await getDocs(collection(db, 'notes'))
  return snapshot.docs.map((d) => String(d.data().text))
}
