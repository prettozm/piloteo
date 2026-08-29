import unittest
import server

class SecurityAndScopeTests(unittest.TestCase):
    def setUp(self):
        self.state={
            "consultants":[
                {"id":"U1","nom":"Un","trigramme":"UN1","statut":"en poste","admin":False,"tjmBase":500,"dateEmbauche":"2026-01-01","dateDepart":None,"tempsPartiel":[]},
                {"id":"U2","nom":"Deux","trigramme":"DE2","statut":"en poste","admin":False,"tjmBase":900,"dateEmbauche":"2026-01-01","dateDepart":None,"tempsPartiel":[]},
            ],
            "organisations":[{"id":"O1","nom":"Client 1"},{"id":"O2","nom":"Client 2"}],
            "affaires":[
                {"id":"A1","organisationId":"O1","pilote":"U1","piloteCommercial":"U1","repartitionCommerciale":[]},
                {"id":"A2","organisationId":"O2","pilote":"U2","piloteCommercial":"U2","repartitionCommerciale":[]},
            ],
            "missions":[{"id":"M1","affaireId":"A1","consultantId":"U1"},{"id":"M2","affaireId":"A2","consultantId":"U2"}],
            "saisies":[{"id":"S1","consultantId":"U1","missionId":"M1"},{"id":"S2","consultantId":"U2","missionId":"M2"}],
            "notesFrais":[{"id":"N1","consultantId":"U1","affaireId":"A1"},{"id":"N2","consultantId":"U2","affaireId":"A2"}],
            "bordereauxFrais":[{"numero":"B1","consultantId":"U1","statut":"en saisie","datePaiement":None},{"numero":"B2","consultantId":"U2","statut":"en saisie","datePaiement":None}],
            "factures":[{"id":"F1","affaireId":"A1"},{"id":"F2","affaireId":"A2"}],
            "methodes":[],"typesTerritoire":[],"domainesIntervention":[],"categoriesFrais":[]
        }

    def test_password_hash(self):
        salt,digest,it=server.hash_password("un-mot-de-passe-solide")
        self.assertTrue(server.verify_password("un-mot-de-passe-solide",salt,digest,it))
        self.assertFalse(server.verify_password("mauvais",salt,digest,it))

    def test_user_does_not_receive_unrelated_affair(self):
        out=server.filter_state(self.state,{"role":"user","consultant_id":"U1"})
        self.assertEqual([a["id"] for a in out["affaires"]],["A1"])
        self.assertEqual([o["id"] for o in out["organisations"]],["O1"])
        self.assertEqual([s["id"] for s in out["saisies"]],["S1"])
        self.assertEqual([f["id"] for f in out["factures"]],["F1"])

    def test_other_consultant_tjm_is_redacted(self):
        out=server.filter_state(self.state,{"role":"user","consultant_id":"U1"})
        u2=next(c for c in out["consultants"] if c["id"]=="U2")
        self.assertEqual(u2["tjmBase"],0)

    def test_user_cannot_edit_consultants(self):
        ok,_=server.can_change({"role":"user","consultant_id":"U1"},"consultants","update",self.state["consultants"][0],self.state["consultants"][0],self.state)
        self.assertFalse(ok)

    def test_user_can_edit_own_time_only(self):
        ok,_=server.can_change({"role":"user","consultant_id":"U1"},"saisies","update",self.state["saisies"][0],self.state["saisies"][0],self.state)
        no,_=server.can_change({"role":"user","consultant_id":"U1"},"saisies","update",self.state["saisies"][1],self.state["saisies"][1],self.state)
        self.assertTrue(ok); self.assertFalse(no)

    def test_pilot_can_edit_own_affair(self):
        a=self.state["affaires"][0]
        ok,_=server.can_change({"role":"user","consultant_id":"U1"},"affaires","update",a,dict(a),self.state)
        self.assertTrue(ok)

    def test_user_cannot_mark_expense_report_paid(self):
        old=self.state["bordereauxFrais"][0]
        new=dict(old,statut="payée",datePaiement="2026-08-29")
        ok,_=server.can_change({"role":"user","consultant_id":"U1"},"bordereauxFrais","update",old,new,self.state)
        self.assertFalse(ok)

    def test_diff_collection(self):
        d=server.diff_collection([{"id":"1","v":1}],[{"id":"1","v":2},{"id":"2","v":3}],"id")
        self.assertEqual([(x[0],x[1]) for x in d],[('update','1'),('add','2')])

if __name__=='__main__': unittest.main()
