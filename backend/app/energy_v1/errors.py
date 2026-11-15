class EnergyError(Exception):
    def __init__(self, code, message, field=None, status=400):
        self.code, self.message, self.field, self.status = code, message, field, status
        super().__init__(message)
